// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.30;

import {Market} from "./IPoolManager.sol";

// Vendored (minimal) from phoenix-private `contracts/interfaces/IDefaultCorkController.sol` at
// commit 0c22c5d3 (v1.1.2). Only `PoolCreationParams` and `createNewPool` are vendored.

/// @notice Parameters for creating a new pool.
/// This includes initializing the fee. Although it can still be modified later,
/// all fees are percentage in 18 decimals (e.g. 1% = 1e18); max 5e18 (5%) enforced at creation.
/// @dev FOOTGUN: the unwind fee comes BEFORE the swap fee — always construct with NAMED FIELDS.
struct PoolCreationParams {
    Market pool;
    /// UnwindSwap/unwindExercise fee percentage in 18 decimals (e.g. 1% = 1e18).
    uint256 unwindSwapFeePercentage;
    /// Swap/exercise fee percentage in 18 decimals (e.g. 1% = 1e18).
    uint256 swapFeePercentage;
    /// Is whitelist enabled for the new pool.
    bool isWhitelistEnabled;
}

/// @title IDefaultCorkController
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Minimal surface of DefaultCorkController used by the market creator.
interface IDefaultCorkController {
    /// @dev Initialize cork pool. Gated by POOL_CREATOR_ROLE = keccak256("POOL_CREATOR_ROLE").
    /// @param params Parameters for the new pool.
    function createNewPool(PoolCreationParams calldata params) external;
}
