// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FixedRateOracleFactory} from "./FixedRateOracleFactory.sol";
import {IDefaultCorkController, PoolCreationParams} from "./interfaces/IDefaultCorkController.sol";
import {IPoolManager, Market, MarketId} from "./interfaces/IPoolManager.sol";

/// @title CorkMarketCreator
/// @notice Thin permissionless wrapper that creates Cork markets through
///         `DefaultCorkController.createNewPool`, deploying a fixed-rate oracle on the way
///         (CREATE2 keyed by rate; each rate can be used once per factory).
/// @dev This contract holds POOL_CREATOR_ROLE on the controller; the contract itself restricts
///      nobody. There is deliberately NO caller restriction on `createMarket`: market creation
///      is permissionless. The wrapper performs no validation of its own. A repeat call with an
///      already-used rate reverts at the oracle factory (CREATE2 collision, no error data),
///      before phoenix is reached; every other creation-time check is phoenix's, bubbled up
///      unchanged (expiry not in the future: `InvalidExpiry()`). No owner, no admin functions,
///      no upgradeability.
contract CorkMarketCreator {
    /// @notice Thrown when a constructor address argument is zero.
    error ZeroAddress();

    /// @notice Emitted when a market was created by this call.
    event MarketCreated(
        MarketId indexed id,
        address oracle,
        address collateralAsset,
        address referenceAsset,
        uint256 expiryTimestamp,
        uint256 rate
    );

    /// @notice The Cork controller this wrapper creates pools through.
    IDefaultCorkController public immutable controller;
    /// @notice The Cork pool manager, used only to compute the market id for the event.
    IPoolManager public immutable poolManager;
    /// @notice The fixed-rate oracle factory (CREATE2 keyed by rate, one deploy per rate).
    FixedRateOracleFactory public immutable oracleFactory;

    constructor(IDefaultCorkController controller_, IPoolManager poolManager_, FixedRateOracleFactory oracleFactory_) {
        if (
            address(controller_) == address(0) || address(poolManager_) == address(0)
                || address(oracleFactory_) == address(0)
        ) revert ZeroAddress();
        controller = controller_;
        poolManager = poolManager_;
        oracleFactory = oracleFactory_;
    }

    /// @notice Parameters for creating a market with a fixed-rate oracle.
    struct CreateParams {
        address collateralAsset;
        address referenceAsset;
        uint256 expiryTimestamp;
        /// Fixed oracle rate, 1e18-scaled, 1 REF quoted in CA.
        uint256 rate;
        /// Creation requires rateMin > 0 AND rateMin < rateMax (STRICT); bootstrap requires
        /// rateMin <= rate <= rateMax. Recipe for a fixed rate: rateMin = rate.
        uint256 rateMin;
        /// Recipe for a fixed rate: rate + 1 (smallest value passing the strict check).
        uint256 rateMax;
        /// Unvalidated by phoenix; use 0 for a fixed rate (freezes drift).
        uint256 rateChangePerDayMax;
        /// Unvalidated by phoenix; use 0 for a fixed rate.
        uint256 rateChangeCapacityMax;
        /// Swap/exercise fee, 1e18 = 1%; max 5e18 (5%) enforced at creation.
        uint256 swapFeePercentage;
        /// UnwindSwap/unwindExercise fee, same scale and cap.
        uint256 unwindSwapFeePercentage;
        bool isWhitelistEnabled;
    }

    /// @notice Creates a Cork market for `params`, deploying the fixed-rate oracle for
    ///         `params.rate`.
    /// @dev Deliberately callable by anyone — creation is permissionless. An already-used rate
    ///      reverts at the oracle factory (CREATE2 collision, no error data) before phoenix is
    ///      reached; other invalid parameters revert with the phoenix error, bubbled up unchanged
    ///      (a non-future expiry reverts `InvalidExpiry()`). Market identity (`MarketId`) covers
    ///      only the `Market` struct fields; the fees and `isWhitelistEnabled` are not part of
    ///      identity.
    /// @param params The market parameters; see the `CreateParams` field docs.
    function createMarket(CreateParams calldata params) external {
        // Deploy the fixed-rate oracle (reverts InvalidRate() for a zero rate, and reverts on
        // the CREATE2 collision if this rate was already used).
        address oracle = oracleFactory.deploy(params.rate);

        // Field order is load-bearing for the id hash.
        Market memory market = Market({
            collateralAsset: params.collateralAsset,
            referenceAsset: params.referenceAsset,
            expiryTimestamp: params.expiryTimestamp,
            rateMin: params.rateMin,
            rateMax: params.rateMax,
            rateChangePerDayMax: params.rateChangePerDayMax,
            rateChangeCapacityMax: params.rateChangeCapacityMax,
            rateOracle: oracle
        });

        // NAMED fields: PoolCreationParams puts the unwind fee BEFORE the swap fee.
        controller.createNewPool(
            PoolCreationParams({
                pool: market,
                unwindSwapFeePercentage: params.unwindSwapFeePercentage,
                swapFeePercentage: params.swapFeePercentage,
                isWhitelistEnabled: params.isWhitelistEnabled
            })
        );

        emit MarketCreated(
            poolManager.getId(market),
            oracle,
            params.collateralAsset,
            params.referenceAsset,
            params.expiryTimestamp,
            params.rate
        );
    }
}
