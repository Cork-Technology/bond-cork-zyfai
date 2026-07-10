// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FixedRateOracle} from "./FixedRateOracle.sol";

/// @title FixedRateOracleFactory
/// @notice Deterministic (CREATE2) factory for `FixedRateOracle` instances, keyed by rate.
///         Each rate can be deployed exactly once per factory.
/// @dev No admin surface. `computeAddress` lets agents precompute the oracle address off-chain
///      before any transaction is sent.
contract FixedRateOracleFactory {
    /// @notice Emitted when an oracle is deployed.
    /// @param rate The fixed rate the oracle was deployed with.
    /// @param oracle The deployed oracle address.
    event OracleDeployed(uint256 indexed rate, address indexed oracle);

    /// @notice Deploys the oracle for `rate`.
    /// @dev Reverts (CREATE2 salt collision, no error data) if the oracle for `rate` already
    ///      exists. A zero rate reverts with `IRateOracle.InvalidRate()`, bubbling up from the
    ///      `FixedRateOracle` constructor.
    /// @param rate The fixed rate (1 REF quoted in CA, 1e18-scaled). Must be nonzero.
    /// @return oracle The deployed oracle address.
    function deploy(uint256 rate) external returns (address oracle) {
        oracle = address(new FixedRateOracle{salt: bytes32(rate)}(rate));
        emit OracleDeployed(rate, oracle);
    }

    /// @notice Computes the deterministic CREATE2 address of the oracle for `rate`.
    /// @dev salt = bytes32(rate); init-code hash = keccak256(creationCode ++ abi.encode(rate)).
    /// @param rate The fixed rate the oracle is keyed by.
    /// @return The deterministic oracle address (which may not be deployed yet).
    function computeAddress(uint256 rate) public view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(FixedRateOracle).creationCode, abi.encode(rate)));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(rate), initCodeHash))))
        );
    }
}
