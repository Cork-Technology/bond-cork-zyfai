// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {CorkLimitOrderAdapter} from "../../src/CorkLimitOrderAdapter.sol";
import {Address, AddressLib, IOrderMixin, MakerTraits} from "../../src/interfaces/I1inchLimitOrderProtocol.sol";
import {MarketId} from "../../src/interfaces/IPoolManager.sol";
import {ERC1271Wallet} from "../mocks/ERC1271Wallet.sol";
import {MockERC20, MockJITPoolManager} from "../mocks/JITMocks.sol";

/// @dev Fill surface of the real LOP v4 needed here (canonical ABI: the struct's
///      Address/MakerTraits value types encode as uint256, matching lib.mjs).
interface ILopFill {
    error BadSignature();

    function hashOrder(IOrderMixin.Order calldata order) external view returns (bytes32);

    function fillContractOrderArgs(
        IOrderMixin.Order calldata order,
        bytes calldata signature,
        uint256 amount,
        uint256 takerTraits,
        bytes calldata args
    ) external returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash);
}

/// @notice Arbitrum fork proof of the CONTRACT-maker path against the REAL 1inch Limit
///         Order Protocol v4 (Aggregation Router v6), gated on ARBITRUM_RPC_URL like the
///         CorkMarketCreator fork suite. Proves the two assumptions the contract-maker
///         examples rest on:
///
///         1. A minimal ERC-1271 wallet's raw 65-byte owner signature passes the
///            contract-order signature check used by `fillContractOrderArgs`.
///         2. `fillContractOrderArgs` completes WITH the JIT pre-interaction extension
///            attached (extension pre-interaction slot = adapter address ++
///            abi.encode(poolId); salt low 160 bits commit to keccak256(extension);
///            makerTraits bits 249 HAS_EXTENSION + 252 PRE_INTERACTION set), and the
///            CorkLimitOrderAdapter mints for the wallet (`JITMinted` fires).
///
///         The pool manager is the JIT mock — only the LOP is real; the Phoenix side of
///         JIT minting is covered by test/CorkLimitOrderAdapter.jit.t.sol and the scripts.
contract ContractMakerFillForkTest is Test {
    using AddressLib for Address;

    // Canonical LOP v4 address (identical on Ethereum mainnet and Arbitrum One).
    address internal constant LOP = 0x111111125421cA6dc452d289314280a0f8842A65;

    // MakerTraits flag bits (MakerTraitsLib).
    uint256 internal constant ALLOW_MULTIPLE_FILLS = 1 << 254;
    uint256 internal constant PRE_INTERACTION = 1 << 252;
    uint256 internal constant HAS_EXTENSION = 1 << 249;

    // TakerTraits flag bits (TakerTraitsLib).
    uint256 internal constant MAKER_AMOUNT_FLAG = 1 << 255; // `amount` is a making amount
    uint256 internal constant EXT_LEN_SHIFT = 224;

    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "Order(uint256 salt,address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 makerTraits)"
    );

    bool internal forkConfigured;

    uint256 internal ownerKey;
    address internal ownerAddr;
    ERC1271Wallet internal wallet;
    address internal taker;

    MockERC20 internal collateral;
    MockERC20 internal premium;
    MockJITPoolManager internal poolManager;
    CorkLimitOrderAdapter internal adapter;
    MarketId internal poolId;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC_URL", string(""));
        forkConfigured = bytes(rpcUrl).length != 0;
        if (!forkConfigured) return;

        vm.createSelectFork(rpcUrl);

        (ownerAddr, ownerKey) = makeAddrAndKey("wallet-owner");
        wallet = new ERC1271Wallet(ownerAddr);
        taker = makeAddr("taker");

        collateral = new MockERC20("USDC", 6, false);
        premium = new MockERC20("PREMIUM", 18, false);
        poolManager = new MockJITPoolManager(collateral);
        adapter = new CorkLimitOrderAdapter(LOP, poolManager);
        poolId = poolManager.poolId();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _addr(address a) internal pure returns (Address) {
        return Address.wrap(uint256(uint160(a)));
    }

    /// @dev Ports buildExtension from lib.mjs: 32-byte header of 8 packed uint32
    ///      cumulative END offsets (field 0 lowest), only field 6
    ///      (PreInteractionData) populated with target ++ extraData.
    function _jitExtension() internal view returns (bytes memory extension) {
        bytes memory pre = abi.encodePacked(address(adapter), abi.encode(poolId)); // 20 + 32 bytes
        uint256 len = pre.length;
        uint256 offsets = (len << (32 * 6)) | (len << (32 * 7));
        extension = abi.encodePacked(bytes32(offsets), pre);
    }

    /// @dev Ports saltForExtension from lib.mjs.
    function _saltFor(bytes memory extension, uint256 entropy) internal pure returns (uint256) {
        return (entropy << 160) | (uint256(keccak256(extension)) & type(uint160).max);
    }

    /// @dev EIP-712 hash exactly as lib.mjs's orderTypedData computes it, to
    ///      cross-check against the real contract's hashOrder().
    function _manualOrderHash(IOrderMixin.Order memory order) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("1inch Aggregation Router")),
                keccak256(bytes("6")),
                block.chainid,
                LOP
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.salt,
                order.maker,
                order.receiver,
                order.makerAsset,
                order.takerAsset,
                order.makingAmount,
                order.takingAmount,
                order.makerTraits
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    /// @dev 65-byte raw (r ++ s ++ v) signature — what the ERC-1271 wallet recovers.
    ///      This is the CONTRACT-maker delta vs the EOA path's EIP-2098 compact split.
    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Ports buildTakerTraits from lib.mjs (no target, no interaction).
    function _takerTraits(uint256 threshold, bytes memory extension)
        internal
        pure
        returns (uint256 traits, bytes memory args)
    {
        traits = MAKER_AMOUNT_FLAG | (extension.length << EXT_LEN_SHIFT) | (threshold & ((1 << 185) - 1));
        args = extension;
    }

    function _walletApprove(address token, address spender, uint256 amount) internal {
        vm.prank(ownerAddr);
        wallet.execute(token, abi.encodeCall(MockERC20.approve, (spender, amount)));
    }

    // ── Assumption 1: plain contract-maker order via fillContractOrderArgs ──

    function test_fork_erc1271Wallet_plainContractOrder_fills() public {
        vm.skip(!forkConfigured);

        MockERC20 makerToken = new MockERC20("MAKER", 18, false);
        makerToken.mint(address(wallet), 100e18);
        _walletApprove(address(makerToken), LOP, type(uint256).max);

        premium.mint(taker, 100e18);
        vm.prank(taker);
        premium.approve(LOP, type(uint256).max);

        IOrderMixin.Order memory order = IOrderMixin.Order({
            salt: 42,
            maker: _addr(address(wallet)),
            receiver: Address.wrap(0),
            makerAsset: _addr(address(makerToken)),
            takerAsset: _addr(address(premium)),
            makingAmount: 10e18,
            takingAmount: 3e18,
            makerTraits: MakerTraits.wrap(ALLOW_MULTIPLE_FILLS)
        });

        bytes32 orderHash = ILopFill(LOP).hashOrder(order);
        assertEq(orderHash, _manualOrderHash(order), "lib.mjs EIP-712 domain/typehash must match hashOrder()");

        bytes memory sig = _sign(ownerKey, orderHash);
        (uint256 traits, bytes memory args) = _takerTraits(3e18, "");

        vm.prank(taker);
        (uint256 made, uint256 took,) = ILopFill(LOP).fillContractOrderArgs(order, sig, 10e18, traits, args);

        assertEq(made, 10e18, "making amount");
        assertEq(took, 3e18, "taking amount");
        assertEq(makerToken.balanceOf(taker), 10e18, "taker received maker asset");
        assertEq(premium.balanceOf(address(wallet)), 3e18, "wallet received taker asset");
    }

    function test_fork_erc1271Wallet_wrongSigner_reverts() public {
        vm.skip(!forkConfigured);

        MockERC20 makerToken = new MockERC20("MAKER", 18, false);
        makerToken.mint(address(wallet), 100e18);
        _walletApprove(address(makerToken), LOP, type(uint256).max);

        premium.mint(taker, 100e18);
        vm.prank(taker);
        premium.approve(LOP, type(uint256).max);

        IOrderMixin.Order memory order = IOrderMixin.Order({
            salt: 43,
            maker: _addr(address(wallet)),
            receiver: Address.wrap(0),
            makerAsset: _addr(address(makerToken)),
            takerAsset: _addr(address(premium)),
            makingAmount: 10e18,
            takingAmount: 3e18,
            makerTraits: MakerTraits.wrap(ALLOW_MULTIPLE_FILLS)
        });

        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        bytes memory sig = _sign(strangerKey, ILopFill(LOP).hashOrder(order));
        (uint256 traits, bytes memory args) = _takerTraits(3e18, "");

        vm.prank(taker);
        vm.expectRevert(ILopFill.BadSignature.selector);
        ILopFill(LOP).fillContractOrderArgs(order, sig, 10e18, traits, args);
    }

    // ── Assumption 2: JIT pre-interaction extension + contract maker ─────────

    function test_fork_erc1271Wallet_jitContractOrder_fillsAndMints() public {
        vm.skip(!forkConfigured);

        uint256 cstShares = 20_000e18;
        uint256 premiumIn = 400e18;
        address cst = address(poolManager.cst());

        // Ceremony prereqs for a contract maker: wallet holds CA, approves
        // CA -> adapter and cST -> LOP. It holds ZERO cST before the fill.
        collateral.mint(address(wallet), 50_000e6);
        _walletApprove(address(collateral), address(adapter), type(uint256).max);
        _walletApprove(cst, LOP, type(uint256).max);

        premium.mint(taker, premiumIn);
        vm.prank(taker);
        premium.approve(LOP, type(uint256).max);

        bytes memory extension = _jitExtension();
        IOrderMixin.Order memory order = IOrderMixin.Order({
            salt: _saltFor(extension, 1),
            maker: _addr(address(wallet)),
            receiver: Address.wrap(0),
            makerAsset: _addr(cst),
            takerAsset: _addr(address(premium)),
            makingAmount: cstShares,
            takingAmount: premiumIn,
            makerTraits: MakerTraits.wrap(ALLOW_MULTIPLE_FILLS | PRE_INTERACTION | HAS_EXTENSION)
        });

        bytes32 orderHash = ILopFill(LOP).hashOrder(order);
        assertEq(orderHash, _manualOrderHash(order), "lib.mjs EIP-712 hash must match hashOrder()");
        bytes memory sig = _sign(ownerKey, orderHash);
        (uint256 traits, bytes memory args) = _takerTraits(premiumIn, extension);

        uint256 expectedCollateral = poolManager.previewMint(poolId, cstShares); // 20_000e6

        assertEq(MockERC20(cst).balanceOf(address(wallet)), 0, "wallet starts with zero cST");

        vm.expectEmit(true, true, true, true, address(adapter));
        emit CorkLimitOrderAdapter.JITMinted(poolId, address(wallet), cstShares, expectedCollateral);

        vm.prank(taker);
        (uint256 made, uint256 took,) = ILopFill(LOP).fillContractOrderArgs(order, sig, cstShares, traits, args);

        assertEq(made, cstShares, "making amount");
        assertEq(took, premiumIn, "taking amount");
        assertEq(MockERC20(cst).balanceOf(taker), cstShares, "taker received JIT-minted cST");
        assertEq(MockERC20(cst).balanceOf(address(wallet)), 0, "wallet's fresh cST fully swept by LOP");
        assertEq(poolManager.cpt().balanceOf(address(wallet)), cstShares, "wallet keeps the cPT leg");
        assertEq(premium.balanceOf(address(wallet)), premiumIn, "wallet received the premium");
        assertEq(collateral.balanceOf(address(wallet)), 50_000e6 - expectedCollateral, "wallet paid collateral");
        assertEq(collateral.balanceOf(address(adapter)), 0, "adapter holds no CA");
    }
}
