// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.30;

// Vendored from phoenix-private `contracts/interfaces/IRateOracle.sol` at commit 0c22c5d3 (v1.1.2).
// Only the `IRateOracle` interface is vendored. The `IComposableRateOracle` interface and the
// `MinimalAggregatorV3Interface` import are deliberately stripped: `rate()` is the only method
// phoenix ever calls on a market's rate oracle (single call site: ConstraintRateAdapter._fetchRate).

/// @title IRateOracle
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Interface which provides NAV ratio.
interface IRateOracle {
    /// @notice thrown when rate is 0
    error InvalidRate();

    /// @notice thrown when morpho oracle address is 0
    error ZeroAddress();

    /// @notice Returns the value of 1 Reference Asset quoted in Collateral Asset, scaled by 1e18.
    /// @dev A rate of 0.8e18 means 1 REF is worth 0.8 CA
    /// @return rate The exchange rate representing REF value in CA terms (REFCA in finance notation).
    function rate() external view returns (uint256);
}
