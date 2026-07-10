// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {FixedRateOracle} from "../src/FixedRateOracle.sol";
import {FixedRateOracleFactory} from "../src/FixedRateOracleFactory.sol";
import {IRateOracle} from "../src/interfaces/IRateOracle.sol";

contract FixedRateOracleFactoryTest is Test {
    FixedRateOracleFactory internal factory;

    function setUp() public {
        factory = new FixedRateOracleFactory();
    }

    function test_computeAddress_matchesDeployedAddress() public {
        uint256 rate = 1.5e18;
        address predicted = factory.computeAddress(rate);
        address deployed = factory.deploy(rate);
        assertEq(deployed, predicted, "computeAddress parity");
        assertGt(deployed.code.length, 0, "no code at deployed address");
        assertEq(FixedRateOracle(deployed).rate(), rate, "oracle rate mismatch");
    }

    function testFuzz_computeAddress_matchesDeployedAddress(uint256 rate) public {
        rate = bound(rate, 1, type(uint256).max);
        address predicted = factory.computeAddress(rate);
        address deployed = factory.deploy(rate);
        assertEq(deployed, predicted, "computeAddress parity");
        assertEq(FixedRateOracle(deployed).rate(), rate, "oracle rate mismatch");
    }

    function test_deploy_repeatRate_reverts() public {
        uint256 rate = 2e18;

        // Fresh deploy: OracleDeployed emitted with correct fields.
        vm.expectEmit(true, true, true, true, address(factory));
        emit FixedRateOracleFactory.OracleDeployed(rate, factory.computeAddress(rate));
        address first = factory.deploy(rate);
        assertGt(first.code.length, 0, "no code at deployed address");

        // Second deploy with the same rate hits the CREATE2 salt collision. The collision
        // carries no error data, so assert failure via a low-level call instead of expectRevert.
        (bool ok,) = address(factory).call(abi.encodeCall(factory.deploy, (rate)));
        assertFalse(ok, "repeat deploy must revert");
    }

    function test_deploy_distinctRates_distinctAddresses() public {
        address a = factory.deploy(1e18);
        address b = factory.deploy(2e18);
        assertNotEq(a, b, "distinct rates must map to distinct oracles");
        assertEq(FixedRateOracle(a).rate(), 1e18, "oracle a rate");
        assertEq(FixedRateOracle(b).rate(), 2e18, "oracle b rate");
    }

    function test_deploy_zeroRate_reverts() public {
        // Bubbles up from the FixedRateOracle constructor.
        vm.expectRevert(IRateOracle.InvalidRate.selector);
        factory.deploy(0);
    }
}
