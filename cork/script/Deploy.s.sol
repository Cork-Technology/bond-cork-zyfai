// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";

import {CorkLimitOrderAdapter} from "../src/CorkLimitOrderAdapter.sol";
import {CorkMarketCreator} from "../src/CorkMarketCreator.sol";
import {FixedRateOracleFactory} from "../src/FixedRateOracleFactory.sol";
import {IDefaultCorkController} from "../src/interfaces/IDefaultCorkController.sol";
import {IPoolManager} from "../src/interfaces/IPoolManager.sol";

/// @notice Deploys the FixedRateOracleFactory, the CorkMarketCreator and the
///         CorkLimitOrderAdapter (JIT minting), then prints the exact
///         grantRole call the admin must make on the controller.
/// @dev Required environment variables:
///      - CONTROLLER:   address of DefaultCorkController (shadow Phoenix deployment)
///      - POOL_MANAGER: address of CorkPoolManager
///      - LOP:          address of the 1inch Limit Order Protocol (Aggregation Router v6);
///                      canonical on Arbitrum One: 0x111111125421cA6dc452d289314280a0f8842A65
contract Deploy is Script {
    bytes32 internal constant POOL_CREATOR_ROLE = keccak256("POOL_CREATOR_ROLE");

    function run()
        external
        returns (FixedRateOracleFactory factory, CorkMarketCreator creator, CorkLimitOrderAdapter lopAdapter)
    {
        address controller = vm.envAddress("CONTROLLER");
        address poolManager = vm.envAddress("POOL_MANAGER");
        address lop = vm.envAddress("LOP");

        vm.startBroadcast();
        factory = new FixedRateOracleFactory();
        creator = new CorkMarketCreator(IDefaultCorkController(controller), IPoolManager(poolManager), factory);
        lopAdapter = new CorkLimitOrderAdapter(lop, IPoolManager(poolManager));
        vm.stopBroadcast();

        console.log("FixedRateOracleFactory:", address(factory));
        console.log("CorkMarketCreator:     ", address(creator));
        console.log("CorkLimitOrderAdapter: ", address(lopAdapter));
        console.log("");
        console.log("Admin wiring step - grant POOL_CREATOR_ROLE on the controller to the creator:");
        console.log("");
        console.log(
            string.concat(
                "  cast send ",
                vm.toString(controller),
                " 'grantRole(bytes32,address)' ",
                vm.toString(POOL_CREATOR_ROLE),
                " ",
                vm.toString(address(creator)),
                " --rpc-url $ARBITRUM_RPC_URL --from <admin>"
            )
        );
        console.log("");
        console.log("  calldata:");
        console.log(
            string.concat(
                "  ",
                vm.toString(abi.encodeWithSignature("grantRole(bytes32,address)", POOL_CREATOR_ROLE, address(creator)))
            )
        );
    }
}
