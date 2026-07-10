// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.30;

// Vendored (minimal) from phoenix-private `contracts/interfaces/IPoolManager.sol` at commit
// 0c22c5d3 (v1.1.2). Only the `MarketId` type, the `Market` struct, the two views the market
// creator needs (`getId`, `market`), and the mint surface the JIT hook needs (`shares`,
// `previewMint`, `mint`) are vendored.

/// @notice The market id of a pool. Will be used in most functions to specify the pool to interact.
/// @dev Calculated by hashing the `Market` struct: keccak256(abi.encode(Market)).
type MarketId is bytes32;

/// @notice Struct containing a full info about a pool.
/// @dev FIELD ORDER IS LOAD-BEARING: `MarketId = keccak256(abi.encode(market))`, so the order
///      below must match phoenix exactly. `collateralAsset` comes FIRST (a `getId` natspec in
///      phoenix lists `referenceAsset` first — that natspec is wrong).
struct Market {
    /// The pool collateral asset address.
    address collateralAsset;
    /// The pool reference asset address.
    address referenceAsset;
    /// Pool expiry in unix epoch timestamp in seconds.
    uint256 expiryTimestamp;
    /// Lower limit of rate that can be returned by `rateOracle`; rates below are clamped up.
    uint256 rateMin;
    /// Upper limit of rate that can be returned by `rateOracle`; rates above are clamped down.
    uint256 rateMax;
    /// Maximum rate change allowance per day in absolute value.
    uint256 rateChangePerDayMax;
    /// Maximum accumulated rate change allowed from rateChangePerDayMax.
    uint256 rateChangeCapacityMax;
    /// The rate oracle address returning the fundamental rate between the assets.
    address rateOracle;
}

/// @title IPoolManager
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Minimal read surface of CorkPoolManager used by the market creator.
interface IPoolManager {
    /// @notice Returns the market id for the given market parameters.
    /// @dev The phoenix implementation is `pure`; declared `view` here to match the phoenix
    ///      interface declaration.
    function getId(Market calldata marketParameters) external view returns (MarketId marketId);

    /// @notice Returns the stored market parameters for a pool id.
    /// @dev Returns an ALL-ZERO struct for unknown markets. The phoenix natspec claims this
    ///      reverts for uninitialized markets — it does NOT; the implementation has no such
    ///      check. Existence predicate: `collateralAsset != 0 && referenceAsset != 0` (mirror
    ///      of phoenix's own `PoolLibrary.isInitialized`).
    function market(MarketId poolId) external view returns (Market memory parameters);

    /// @notice Returns the contract addresses of cPT shares and cST shares for a given market.
    /// @param poolId The Cork pool identifier.
    /// @return principalToken Contract address of the cPT shares (Collateral Principal Token).
    /// @return swapToken Contract address of the cST shares (Cork Swap Token).
    function shares(MarketId poolId) external view returns (address principalToken, address swapToken);

    /// @notice Simulates `mint` — the collateral (native decimals) required to mint exactly
    ///         `cptAndCstSharesOut` of each share (18 decimals).
    /// @dev Ceiling division, same conversion logic as `mint`. Returns 0 if minting is paused
    ///      or the market has expired — callers MUST treat 0 as "cannot mint", not "free".
    function previewMint(MarketId poolId, uint256 cptAndCstSharesOut) external view returns (uint256 collateralAssetsIn);

    /// @notice Mints exactly `cptAndCstSharesOut` cST AND cPT shares (18 decimals) to `receiver`,
    ///         pulling the ceiling-divided collateral amount from `msg.sender`.
    /// @dev Gated by the per-market whitelist (`_onlyWhitelisted(poolId, msg.sender)`): markets
    ///      created by `CorkMarketCreator` for the hackathon MUST set `isWhitelistEnabled =
    ///      false` or JIT mints revert. Reverts before expiry checks per phoenix.
    function mint(MarketId poolId, uint256 cptAndCstSharesOut, address receiver)
        external
        returns (uint256 collateralAssetsIn);
}
