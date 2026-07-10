// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {CorkLimitOrderAdapter} from "../src/CorkLimitOrderAdapter.sol";
import {IOrderMixin} from "../src/interfaces/I1inchLimitOrderProtocol.sol";
import {IPoolManager, MarketId} from "../src/interfaces/IPoolManager.sol";
import {MockERC20, MockJITPoolManager, MockLimitOrderProtocol, OrderBuilder} from "./mocks/JITMocks.sol";

contract CorkLimitOrderAdapterJitTest is Test {
    address internal constant BOND = address(0xB07D);
    address internal constant PREMIUM_TOKEN = address(0xFEE);

    MockERC20 internal collateral;
    MockJITPoolManager internal poolManager;
    MockLimitOrderProtocol internal lop;
    CorkLimitOrderAdapter internal hook;
    MarketId internal poolId;

    function setUp() public {
        collateral = new MockERC20("USDC", 6, false);
        _wire();
    }

    /// @dev Wires pool manager + LOP + hook around the current `collateral`, funds BOND with
    ///      50k CA and approves the hook (BOND's one-time setup from the ceremony).
    function _wire() internal {
        poolManager = new MockJITPoolManager(collateral);
        lop = new MockLimitOrderProtocol();
        hook = new CorkLimitOrderAdapter(address(lop), poolManager);
        poolId = poolManager.poolId();

        collateral.mint(BOND, 50_000e6);
        // Direct allowance write: a high-level approve() on a no-return-data token reverts at
        // the caller's decode, and _wire runs for both token flavors.
        collateral.setAllowance(BOND, address(hook), type(uint256).max);
    }

    /// @dev ASK shape: BOND is the maker selling cST for the premium token.
    function _askOrder(uint256 cstShares) internal view returns (IOrderMixin.Order memory) {
        return OrderBuilder.build(BOND, address(poolManager.cst()), PREMIUM_TOKEN, cstShares, 0);
    }

    /// @dev BID shape (someone else's buy order): BOND is the taker delivering cST.
    function _bidOrder(uint256 cstShares) internal view returns (IOrderMixin.Order memory) {
        return OrderBuilder.build(address(0xA11CE), PREMIUM_TOKEN, address(poolManager.cst()), 0, cstShares);
    }

    // -- Authorization ------------------------------------------------------------------------

    function test_reverts_whenCallerIsNotLop() public {
        IOrderMixin.Order memory order = _askOrder(20_000e18);
        vm.expectRevert(CorkLimitOrderAdapter.OnlyLimitOrderProtocol.selector);
        hook.preInteraction(order, "", bytes32(0), address(0), 20_000e18, 0, 0, abi.encode(poolId));
    }

    function test_constructor_zeroAddressReverts() public {
        vm.expectRevert(CorkLimitOrderAdapter.ZeroAddress.selector);
        new CorkLimitOrderAdapter(address(0), poolManager);
        vm.expectRevert(CorkLimitOrderAdapter.ZeroAddress.selector);
        new CorkLimitOrderAdapter(address(lop), IPoolManager(address(0)));
    }

    // -- Maker path (preInteraction, ASK) -----------------------------------------------------

    function test_preInteraction_mintsToMaker() public {
        uint256 cstShares = 20_000e18;
        uint256 expectedCollateral = poolManager.previewMint(poolId, cstShares); // 20_000e6

        vm.expectEmit(true, true, true, true, address(hook));
        emit CorkLimitOrderAdapter.JITMinted(poolId, BOND, cstShares, expectedCollateral);
        lop.callPreInteraction(hook, _askOrder(cstShares), cstShares, 0, abi.encode(poolId));

        assertEq(poolManager.cst().balanceOf(BOND), cstShares, "maker must hold the fresh cST");
        assertEq(poolManager.cpt().balanceOf(BOND), cstShares, "maker must hold the cPT leg");
        assertEq(collateral.balanceOf(BOND), 50_000e6 - expectedCollateral, "maker pays the collateral");
        _assertNoCustody();
    }

    // -- Taker path (takerInteraction, lifting a BID) -------------------------------------------

    function test_takerInteraction_mintsToTaker() public {
        uint256 cstShares = 7_500e18;
        uint256 expectedCollateral = poolManager.previewMint(poolId, cstShares);

        lop.callTakerInteraction(hook, _bidOrder(cstShares), BOND, 0, cstShares, abi.encode(poolId));

        assertEq(poolManager.cst().balanceOf(BOND), cstShares, "taker must hold the fresh cST");
        assertEq(poolManager.cpt().balanceOf(BOND), cstShares, "taker must hold the cPT leg");
        assertEq(collateral.balanceOf(BOND), 50_000e6 - expectedCollateral, "taker pays the collateral");
        _assertNoCustody();
    }

    // -- Guards ---------------------------------------------------------------------------------

    function test_reverts_orderNotForPool() public {
        IOrderMixin.Order memory foreign = OrderBuilder.build(BOND, address(0xDEAD), address(0xBEEF), 1e18, 1e18);
        vm.expectRevert(CorkLimitOrderAdapter.OrderNotForPool.selector);
        lop.callPreInteraction(hook, foreign, 1e18, 1e18, abi.encode(poolId));
    }

    function test_reverts_whenMintPaused() public {
        poolManager.setPaused(true);
        // Build args BEFORE arming expectRevert: _askOrder does an external cst() staticcall.
        IOrderMixin.Order memory order = _askOrder(1e18);
        bytes memory extraData = abi.encode(poolId);
        vm.expectRevert(CorkLimitOrderAdapter.MintUnavailable.selector);
        lop.callPreInteraction(hook, order, 1e18, 0, extraData);
    }

    function test_reverts_onMintAmountDrift() public {
        poolManager.setDriftBps(100); // mint spends 1% more than previewMint quoted
        IOrderMixin.Order memory order = _askOrder(20_000e18);
        bytes memory extraData = abi.encode(poolId);
        vm.expectRevert(); // MockERC20 allowance failure fires first; drift can never spend extra
        lop.callPreInteraction(hook, order, 20_000e18, 0, extraData);
    }

    // -- Non-standard ERC20 collateral -----------------------------------------------------------

    function test_worksWith_noReturnDataCollateral() public {
        collateral = new MockERC20("USDT-style", 6, true);
        _wire();

        uint256 cstShares = 1_000e18;
        lop.callPreInteraction(hook, _askOrder(cstShares), cstShares, 0, abi.encode(poolId));
        assertEq(poolManager.cst().balanceOf(BOND), cstShares, "no-return-data CA must still mint");
        _assertNoCustody();
    }

    /// @dev The hook must end every fill with zero balances and zero dangling allowance —
    ///      capital only transits.
    function _assertNoCustody() internal view {
        assertEq(collateral.balanceOf(address(hook)), 0, "hook must hold no CA");
        assertEq(poolManager.cst().balanceOf(address(hook)), 0, "hook must hold no cST");
        assertEq(poolManager.cpt().balanceOf(address(hook)), 0, "hook must hold no cPT");
        assertEq(collateral.allowance(address(hook), address(poolManager)), 0, "no dangling allowance");
    }
}
