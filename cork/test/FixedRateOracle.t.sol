// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {FixedRateOracle} from "../src/FixedRateOracle.sol";
import {IRateOracle} from "../src/interfaces/IRateOracle.sol";

contract FixedRateOracleTest is Test {
    function test_rate_returnsConstructorRate() public {
        FixedRateOracle oracle = new FixedRateOracle(0.8e18);
        assertEq(oracle.rate(), 0.8e18, "rate mismatch");
    }

    function testFuzz_rate_returnsConstructorRate(uint256 rate) public {
        rate = bound(rate, 1, type(uint256).max);
        FixedRateOracle oracle = new FixedRateOracle(rate);
        assertEq(oracle.rate(), rate, "rate mismatch");
    }

    function test_constructor_zeroRate_reverts() public {
        vm.expectRevert(IRateOracle.InvalidRate.selector);
        new FixedRateOracle(0);
    }
}
