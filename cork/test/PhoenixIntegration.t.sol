// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IErrors} from "phoenix/contracts/interfaces/IErrors.sol";
import {MarketId as PhoenixMarketId} from "phoenix/contracts/interfaces/IPoolManager.sol";
import {BaseTest} from "phoenix/test/forge/BaseTest.sol";

import {CorkLimitOrderAdapter} from "../src/CorkLimitOrderAdapter.sol";
import {CorkMarketCreator} from "../src/CorkMarketCreator.sol";
import {FixedRateOracleFactory} from "../src/FixedRateOracleFactory.sol";
import {IDefaultCorkController} from "../src/interfaces/IDefaultCorkController.sol";
import {IOrderMixin} from "../src/interfaces/I1inchLimitOrderProtocol.sol";
import {IPoolManager, Market, MarketId} from "../src/interfaces/IPoolManager.sol";
import {MockLimitOrderProtocol, OrderBuilder} from "./mocks/JITMocks.sol";

/// @dev Integration tests against the REAL phoenix stack (via phoenix's own `BaseTest`), instead
///      of the local mocks: real `CorkPoolManager` (proxied), real `DefaultCorkController`, real
///      `WhitelistManager`. `BaseTest.setUp` creates a whitelist-DISABLED 18/18 market
///      (`defaultPoolId`) and funds alice/bob/charlie/bravo; bravo holds all admin roles.
///      Only the 1inch LOP itself stays mocked — it merely drives the interaction callbacks.
contract PhoenixIntegrationTest is BaseTest {
    MockLimitOrderProtocol internal lop;
    CorkLimitOrderAdapter internal adapter;
    /// @dev The real pool manager, seen through the adapter's vendored interface.
    IPoolManager internal pool;

    uint256 internal constant CST_SHARES = 100e18;
    uint256 internal constant TAKING_REF = 5e18;

    function setUp() public override {
        super.setUp(); // leaves a bravo prank active; deployments below are made by bravo
        lop = new MockLimitOrderProtocol();
        pool = IPoolManager(address(corkPoolManager));
        adapter = new CorkLimitOrderAdapter(address(lop), pool);
        vm.label(address(adapter), "CorkLimitOrderAdapter");
    }

    /// @dev Phoenix and the adapter each declare their own `MarketId` user type over bytes32.
    function _local(PhoenixMarketId id) internal pure returns (MarketId) {
        return MarketId.wrap(PhoenixMarketId.unwrap(id));
    }

    function _approveAdapterCollateral(address who) internal {
        vm.startPrank(who);
        collateralAsset.approve(address(adapter), type(uint256).max);
        vm.stopPrank();
    }

    // ───────────────────────── JIT mint on the real pool ─────────────────────────

    function test_preInteraction_mintsToMaker_onRealPool() public {
        MarketId poolId = _local(defaultPoolId);
        _approveAdapterCollateral(alice);

        uint256 quoted = pool.previewMint(poolId, CST_SHARES);
        assertGt(quoted, 0, "real pool must quote nonzero");

        uint256 aliceCollateralBefore = collateralAsset.balanceOf(alice);
        uint256 poolCollateralBefore = collateralAsset.balanceOf(address(corkPoolManager));

        // ASK: alice sells cST she does not hold yet.
        IOrderMixin.Order memory order =
            OrderBuilder.build(alice, address(swapToken), address(referenceAsset), CST_SHARES, TAKING_REF);

        vm.expectEmit(true, true, true, true, address(adapter));
        emit CorkLimitOrderAdapter.JITMinted(poolId, alice, CST_SHARES, quoted);
        lop.callPreInteraction(adapter, order, CST_SHARES, TAKING_REF, abi.encode(poolId));

        assertEq(swapToken.balanceOf(alice), CST_SHARES, "cST minted to maker");
        assertEq(principalToken.balanceOf(alice), CST_SHARES, "cPT minted to maker");
        assertEq(collateralAsset.balanceOf(alice), aliceCollateralBefore - quoted, "collateral pulled from maker");
        assertEq(
            collateralAsset.balanceOf(address(corkPoolManager)),
            poolCollateralBefore + quoted,
            "collateral locked in the pool"
        );

        // No custody, no dangling allowance on the adapter.
        assertEq(collateralAsset.balanceOf(address(adapter)), 0);
        assertEq(swapToken.balanceOf(address(adapter)), 0);
        assertEq(principalToken.balanceOf(address(adapter)), 0);
        assertEq(collateralAsset.allowance(address(adapter), address(corkPoolManager)), 0);
    }

    function test_takerInteraction_mintsToTaker_onRealPool() public {
        MarketId poolId = _local(defaultPoolId);
        _approveAdapterCollateral(bob);

        uint256 quoted = pool.previewMint(poolId, CST_SHARES);
        uint256 bobCollateralBefore = collateralAsset.balanceOf(bob);

        // BID: alice buys cST for REF; taker bob delivers cST minted just in time.
        IOrderMixin.Order memory order =
            OrderBuilder.build(alice, address(referenceAsset), address(swapToken), TAKING_REF, CST_SHARES);

        vm.expectEmit(true, true, true, true, address(adapter));
        emit CorkLimitOrderAdapter.JITMinted(poolId, bob, CST_SHARES, quoted);
        lop.callTakerInteraction(adapter, order, bob, TAKING_REF, CST_SHARES, abi.encode(poolId));

        assertEq(swapToken.balanceOf(bob), CST_SHARES, "cST minted to taker");
        assertEq(principalToken.balanceOf(bob), CST_SHARES, "cPT minted to taker");
        assertEq(collateralAsset.balanceOf(bob), bobCollateralBefore - quoted, "collateral pulled from taker");
        assertEq(collateralAsset.allowance(address(adapter), address(corkPoolManager)), 0);
    }

    /// @dev Real ceil-division decimals math: 6-decimal collateral, share amount chosen so the
    ///      conversion must round up. Only reachable with the real `TransferHelper`.
    function test_jitMint_sixDecimalCollateral_ceilDivides() public {
        vm.startPrank(bravo);
        createMarket(2 days, 6, 18, false); // resets defaultPoolId/collateralAsset/swapToken
        collateralAsset.mint(alice, 1_000_000e6);
        vm.stopPrank();

        MarketId poolId = _local(defaultPoolId);
        _approveAdapterCollateral(alice);

        uint256 cstShares = CST_SHARES + 1; // forces rounding in the 18 -> 6 decimals conversion
        uint256 quoted = pool.previewMint(poolId, cstShares);
        assertEq(quoted, 100e6 + 1, "quote is ceil-divided into native decimals");

        uint256 aliceCollateralBefore = collateralAsset.balanceOf(alice);
        IOrderMixin.Order memory order =
            OrderBuilder.build(alice, address(swapToken), address(referenceAsset), cstShares, TAKING_REF);
        lop.callPreInteraction(adapter, order, cstShares, TAKING_REF, abi.encode(poolId));

        assertEq(swapToken.balanceOf(alice), cstShares, "cST minted despite rounding");
        assertEq(collateralAsset.balanceOf(alice), aliceCollateralBefore - quoted, "exact rounded-up collateral pulled");
        assertEq(collateralAsset.allowance(address(adapter), address(corkPoolManager)), 0, "drift guard held");
    }

    // ───────────────────────── real-stack revert paths ─────────────────────────

    /// @dev The adapter is the `msg.sender` of `mint`, so a whitelist-ENABLED market must reject
    ///      it with phoenix's own `NotWhitelisted` — the check the local mocks cannot exercise.
    function test_reverts_whenMarketWhitelistEnabled() public {
        vm.startPrank(bravo);
        createMarket(2 days, 18, 18, true);
        collateralAsset.mint(alice, 1_000e18); // fresh asset; alice is unfunded on it
        vm.stopPrank();

        MarketId poolId = _local(defaultPoolId);
        _approveAdapterCollateral(alice);

        IOrderMixin.Order memory order =
            OrderBuilder.build(alice, address(swapToken), address(referenceAsset), CST_SHARES, TAKING_REF);

        vm.expectRevert(
            abi.encodeWithSelector(IErrors.NotWhitelisted.selector, address(adapter), MarketId.unwrap(poolId))
        );
        lop.callPreInteraction(adapter, order, CST_SHARES, TAKING_REF, abi.encode(poolId));
    }

    /// @dev Past expiry the real `previewMint` returns 0, which the adapter maps to
    ///      `MintUnavailable`.
    function test_reverts_whenMarketExpired() public {
        MarketId poolId = _local(defaultPoolId);
        _approveAdapterCollateral(alice);

        vm.warp(corkPoolManager.expiry(defaultPoolId) + 1);

        IOrderMixin.Order memory order =
            OrderBuilder.build(alice, address(swapToken), address(referenceAsset), CST_SHARES, TAKING_REF);

        vm.expectRevert(CorkLimitOrderAdapter.MintUnavailable.selector);
        lop.callPreInteraction(adapter, order, CST_SHARES, TAKING_REF, abi.encode(poolId));
    }

    // ───────────────────────── full ceremony, end to end ─────────────────────────

    /// @dev The whole hackathon flow against the real stack: permissionless market creation
    ///      through `CorkMarketCreator` (fixed-rate oracle deployed on the way, real
    ///      `DefaultCorkController.createNewPool`), then a JIT mint on the freshly created market.
    function test_endToEnd_createMarketViaCreator_thenJitMint() public {
        FixedRateOracleFactory factory = new FixedRateOracleFactory();
        CorkMarketCreator creator =
            new CorkMarketCreator(IDefaultCorkController(address(defaultCorkController)), pool, factory);

        vm.startPrank(bravo);
        defaultCorkController.grantRole(defaultCorkController.POOL_CREATOR_ROLE(), address(creator));
        vm.stopPrank();

        uint256 rate = 1e18;
        uint256 expiry = block.timestamp + 30 days;

        // Market creation is permissionless: eve (no roles, no funds) creates it.
        vm.startPrank(eve);
        creator.createMarket(
            CorkMarketCreator.CreateParams({
                collateralAsset: address(collateralAsset),
                referenceAsset: address(referenceAsset),
                expiryTimestamp: expiry,
                rate: rate,
                rateMin: rate, // fixed-rate recipe: rateMin = rate, rateMax = rate + 1
                rateMax: rate + 1,
                rateChangePerDayMax: 0,
                rateChangeCapacityMax: 0,
                swapFeePercentage: DEFAULT_BASE_REDEMPTION_FEE,
                unwindSwapFeePercentage: DEFAULT_REVERSE_SWAP_FEE,
                isWhitelistEnabled: false
            })
        );
        vm.stopPrank();

        // Identity check: the market exists on the real pool manager under the id derived from
        // the CREATE2-precomputed oracle address.
        Market memory market = Market({
            collateralAsset: address(collateralAsset),
            referenceAsset: address(referenceAsset),
            expiryTimestamp: expiry,
            rateMin: rate,
            rateMax: rate + 1,
            rateChangePerDayMax: 0,
            rateChangeCapacityMax: 0,
            rateOracle: factory.computeAddress(rate)
        });
        MarketId poolId = pool.getId(market);
        assertEq(pool.market(poolId).collateralAsset, address(collateralAsset), "market stored on real pool manager");

        (address cpt, address cst) = pool.shares(poolId);
        assertTrue(cpt != address(0) && cst != address(0), "share tokens deployed");

        // JIT mint on the new market: bob sells cST he does not hold yet.
        _approveAdapterCollateral(bob);
        uint256 quoted = pool.previewMint(poolId, CST_SHARES);
        assertGt(quoted, 0, "fresh market quotes nonzero");

        uint256 bobCollateralBefore = collateralAsset.balanceOf(bob);
        IOrderMixin.Order memory order = OrderBuilder.build(bob, cst, address(referenceAsset), CST_SHARES, TAKING_REF);
        lop.callPreInteraction(adapter, order, CST_SHARES, TAKING_REF, abi.encode(poolId));

        assertEq(IERC20(cst).balanceOf(bob), CST_SHARES, "cST minted on creator-made market");
        assertEq(IERC20(cpt).balanceOf(bob), CST_SHARES, "cPT minted on creator-made market");
        assertEq(collateralAsset.balanceOf(bob), bobCollateralBefore - quoted, "collateral pulled from bob");
        assertEq(collateralAsset.allowance(address(adapter), address(corkPoolManager)), 0);
    }
}
