// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IRateOracle} from "./interfaces/IRateOracle.sol";

/// @title FixedRateOracle
/// @notice A rate oracle whose rate is fixed forever at deployment.
/// @dev The rate is the value of 1 Reference Asset quoted in Collateral Asset, scaled by 1e18
///      (a rate of 0.8e18 means 1 REF is worth 0.8 CA). The value is set once in the constructor
///      and can never change — no owner, no setters. This is intended for short-lived markets
///      (on the order of ~24 hours), where a hardcoded rate is an acceptable simplification.
contract FixedRateOracle is IRateOracle {
    /// @dev The immutable fixed rate, 1e18-scaled.
    uint256 private immutable _RATE;

    /// @param rate_ The fixed rate (1 REF quoted in CA, 1e18-scaled). Must be nonzero.
    constructor(uint256 rate_) {
        if (rate_ == 0) revert InvalidRate();
        _RATE = rate_;
    }

    /// @inheritdoc IRateOracle
    function rate() external view returns (uint256) {
        return _RATE;
    }
}
