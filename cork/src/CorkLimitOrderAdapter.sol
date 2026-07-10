// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {
    AddressLib,
    Address,
    IOrderMixin,
    IPreInteraction,
    ITakerInteraction
} from "./interfaces/I1inchLimitOrderProtocol.sol";
import {IPoolManager, MarketId} from "./interfaces/IPoolManager.sol";

/// @title CorkLimitOrderAdapter
/// @notice The single 1inch LOP v4 adapter for Cork coverage orders: just-in-time minting in
///         one stateless, custody-free contract.
///
///         JIT MINTING (IPreInteraction + ITakerInteraction). Capital is deployed at the
///         moment of the fill, never before:
///         - `preInteraction` (maker-side, committed in the maker-signed extension): fires
///           BEFORE the LOP pulls the maker asset, so a maker selling cST it does not hold yet
///           gets it minted just in time. The maker must have approved the cST to the LOP.
///         - `takerInteraction` (taker-side, chosen freely per fill, no maker cooperation):
///           fires AFTER the maker asset arrived and BEFORE the LOP pulls the taker asset from
///           `msg.sender`, so a taker lifting a buy-cST bid mints its delivery just in time.
///         Both paths pull collateral ONLY from the party being served (`order.maker` /
///         `taker`), mint via `IPoolManager.mint` with that party as receiver, and hold
///         nothing across transactions. Abuse can only spend the abuser's own allowance.
///         Hook `extraData` = `abi.encode(MarketId)`.
/// @dev Requires markets created with the whitelist DISABLED (phoenix gates `mint` by
///      `_onlyWhitelisted(poolId, msg.sender)`, and `msg.sender` here is this adapter).
///      No owner, no admin functions, no upgradeability, no token custody beyond the duration
///      of the fill transaction.
contract CorkLimitOrderAdapter is IPreInteraction, ITakerInteraction {
    using AddressLib for Address;

    // ─────────────────────────────── Errors ────────────────────────────────

    /// @notice Thrown when a constructor address argument is zero.
    error ZeroAddress();
    /// @notice Thrown when a callback caller is not the 1inch LOP.
    error OnlyLimitOrderProtocol();
    /// @notice Thrown when neither order side is the pool's cST (order/pool mismatch).
    error OrderNotForPool();
    /// @notice Thrown when the pool cannot mint (paused or expired: `previewMint` returned 0).
    error MintUnavailable();
    /// @notice Thrown when `mint` spent a different collateral amount than `previewMint` quoted
    ///         within the same transaction (should be unreachable; guards the exact-allowance
    ///         and no-custody invariants).
    error MintAmountDrift();

    // ─────────────────────────────── Events ────────────────────────────────

    /// @notice Emitted after a successful just-in-time mint inside a fill.
    /// @param poolId The Cork pool the shares were minted in.
    /// @param recipient The party served (order maker or fill taker) — receives cST AND cPT.
    /// @param cstShares Shares minted of each leg (18 decimals) — equals the cST the LOP pulls.
    /// @param collateralIn Collateral pulled from `recipient` (CA native decimals).
    event JITMinted(MarketId indexed poolId, address indexed recipient, uint256 cstShares, uint256 collateralIn);

    // ─────────────────────────────── Storage ────────────────────────────────

    /// @notice The 1inch Limit Order Protocol (Aggregation Router v6) — sole authorized caller
    ///         of the interaction callbacks.
    address public immutable limitOrderProtocol;
    /// @notice The Cork pool manager mints are executed against.
    IPoolManager public immutable poolManager;

    constructor(address limitOrderProtocol_, IPoolManager poolManager_) {
        if (limitOrderProtocol_ == address(0) || address(poolManager_) == address(0)) revert ZeroAddress();
        limitOrderProtocol = limitOrderProtocol_;
        poolManager = poolManager_;
    }

    // ─────────────────────────────── JIT minting (interactions) ─────────────

    /// @inheritdoc IPreInteraction
    /// @dev Maker-side JIT: the party served is `order.maker`; the cST amount is the side of
    ///      the order that matches the pool's swap token (making side for an ASK).
    function preInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata,
        bytes32,
        address,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256,
        bytes calldata extraData
    ) external {
        _jitMint(abi.decode(extraData, (MarketId)), order, order.maker.get(), makingAmount, takingAmount);
    }

    /// @inheritdoc ITakerInteraction
    /// @dev Taker-side JIT: the party served is `taker` (the LOP pulls the taker asset from
    ///      `msg.sender == taker` right after this returns); the cST amount is the order side
    ///      matching the pool's swap token (taking side when lifting a BID).
    function takerInteraction(
        IOrderMixin.Order calldata order,
        bytes calldata,
        bytes32,
        address taker,
        uint256 makingAmount,
        uint256 takingAmount,
        uint256,
        bytes calldata extraData
    ) external {
        _jitMint(abi.decode(extraData, (MarketId)), order, taker, makingAmount, takingAmount);
    }

    /// @dev Shared path: resolve which order side is the pool's cST, quote the exact collateral
    ///      via `previewMint` (phoenix does the ceil-division decimals math), pull it from
    ///      `recipient`, mint both legs back to `recipient`. The LOP's own transferFrom then
    ///      moves the fresh cST. `MintAmountDrift` enforces that the approval granted to the
    ///      pool manager is consumed exactly, leaving no dangling allowance and no stranded CA.
    function _jitMint(
        MarketId poolId,
        IOrderMixin.Order calldata order,
        address recipient,
        uint256 makingAmount,
        uint256 takingAmount
    ) internal {
        if (msg.sender != limitOrderProtocol) revert OnlyLimitOrderProtocol();

        (, address swapToken) = poolManager.shares(poolId);
        uint256 cstShares;
        if (order.makerAsset.get() == swapToken) {
            cstShares = makingAmount;
        } else if (order.takerAsset.get() == swapToken) {
            cstShares = takingAmount;
        } else {
            revert OrderNotForPool();
        }

        uint256 collateralIn = poolManager.previewMint(poolId, cstShares);
        if (collateralIn == 0) revert MintUnavailable();

        address collateralAsset = poolManager.market(poolId).collateralAsset;
        _safeTransferFrom(collateralAsset, recipient, address(this), collateralIn);
        _safeApprove(collateralAsset, address(poolManager), collateralIn);
        uint256 spent = poolManager.mint(poolId, cstShares, recipient);
        if (spent != collateralIn) revert MintAmountDrift();

        emit JITMinted(poolId, recipient, cstShares, collateralIn);
    }

    // ─────────────────────────────── Minimal safe-ERC20 ─────────────────────

    /// @dev Tolerates no-return tokens (USDT-style), reverts on `false`.
    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "SAFE_TRANSFER_FROM_FAILED");
    }

    /// @dev Allowance is always fully consumed by the `mint` in the same call (enforced by
    ///      `MintAmountDrift`), so approving from zero is guaranteed and USDT-style
    ///      approve-race protections are never triggered.
    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "SAFE_APPROVE_FAILED");
    }
}
