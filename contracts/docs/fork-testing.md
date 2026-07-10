# Running the Arbitrum fork tests

Both fork suites are gated on `ARBITRUM_RPC_URL` being nonempty and skip cleanly otherwise:

- `test/fork/ContractMakerFill.fork.t.sol` (ERC-1271 contract-maker fills against the real LOP) needs ONLY `ARBITRUM_RPC_URL` — the LOP is already deployed at its canonical address on any Arbitrum fork.
- `test/fork/CorkMarketCreator.fork.t.sol` additionally needs three address inputs:

```bash
ARBITRUM_RPC_URL=...   # RPC of an Arbitrum One node or fork
CONTROLLER=0x...       # DefaultCorkController
POOL_MANAGER=0x...     # CorkPoolManager
ADMIN=0x...            # holder of DEFAULT_ADMIN_ROLE on the controller
forge test --match-path 'test/fork/*'
```

## Option A: shadow Phoenix deployment

Once the shadow-deployment addresses on Arbitrum One are pinned, point the three variables at them and run against any Arbitrum RPC.

## Option B: throwaway Phoenix stack on a local fork (contingency)

If shadow-deployment addresses are unavailable, deploy a throwaway Phoenix stack onto a local Arbitrum fork from a clone of `phoenix-private` (kept **outside** this repo — this repo must not depend on it). This is how the suite was validated on 2026-07-09 (phoenix pinned at commit `0c22c5d3`, v1.1.2): all 6 fork tests passed against the real `CorkPoolManager`, `DefaultCorkController`, `ConstraintRateAdapter`, `WhitelistManager`, and `SharesFactory`.

1. Start a fork: `anvil --fork-url https://arb1.arbitrum.io/rpc --port 8545 --disable-code-size-limit`
   (the size-limit override is needed because `CorkPoolManager` exceeds the 24,576-byte runtime limit under phoenix's default profile; production uses the `via_ir` profile instead).
2. In the phoenix clone, add the script below as `script/ThrowawayDeploy.s.sol` and run:
   ```bash
   THROWAWAY_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
   forge script script/ThrowawayDeploy.s.sol --rpc-url http://127.0.0.1:8545 \
     --broadcast --skip-simulation --disable-code-size-limit
   ```
   (the private key is anvil's default account 0 — throwaway only, never real funds).
3. Run this repo's fork tests with `ARBITRUM_RPC_URL=http://127.0.0.1:8545` and the `CONTROLLER=`/`POOL_MANAGER=`/`ADMIN=` values the script prints.

The script mirrors phoenix's own `test/forge/BaseTest.sol` wiring, with the real pool manager. The broadcaster becomes ensOwner, admin, operations manager, and treasury:

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ConstraintRateAdapter} from "contracts/core/ConstraintRateAdapter.sol";
import {CorkPoolManager} from "contracts/core/CorkPoolManager.sol";
import {DefaultCorkController} from "contracts/core/DefaultCorkController.sol";
import {WhitelistManager} from "contracts/core/WhitelistManager.sol";
import {SharesFactory} from "contracts/core/assets/SharesFactory.sol";
import {Script, console} from "forge-std/Script.sol";

/// @notice Throwaway full-stack Phoenix deployment for a local Arbitrum fork (anvil).
///         NOT for production use.
contract ThrowawayDeploy is Script {
    function run() external {
        uint256 pk = vm.envUint("THROWAWAY_PK");
        address admin = vm.addr(pk);

        vm.startBroadcast(pk);

        address whitelistImpl = address(new WhitelistManager());
        WhitelistManager whitelistManager = WhitelistManager(
            address(new ERC1967Proxy(whitelistImpl, abi.encodeCall(WhitelistManager.initialize, (admin, admin))))
        );

        DefaultCorkController controller = new DefaultCorkController(admin, admin, admin, address(whitelistManager));
        whitelistManager.grantRole(whitelistManager.CORK_CONTROLLER_ROLE(), address(controller));

        address adapterImpl = address(new ConstraintRateAdapter());
        ConstraintRateAdapter adapter = ConstraintRateAdapter(
            address(new ERC1967Proxy(adapterImpl, abi.encodeCall(ConstraintRateAdapter.initialize, (admin, admin))))
        );

        address poolManagerImpl = address(new CorkPoolManager());
        CorkPoolManager poolManager = CorkPoolManager(
            address(
                new ERC1967Proxy(
                    poolManagerImpl,
                    abi.encodeCall(
                        CorkPoolManager.initialize, (admin, admin, address(adapter), admin, address(whitelistManager))
                    )
                )
            )
        );

        SharesFactory sharesFactory = new SharesFactory(address(poolManager), admin);

        poolManager.grantRole(poolManager.CORK_CONTROLLER_ROLE(), address(controller));
        whitelistManager.setOnceCorkPoolManager(address(poolManager));
        controller.setOnceCorkPoolManager(address(poolManager));
        adapter.setOnceCorkPoolManager(address(poolManager));
        controller.setSharesFactory(address(sharesFactory));

        vm.stopBroadcast();

        console.log("CONTROLLER=%s", address(controller));
        console.log("POOL_MANAGER=%s", address(poolManager));
        console.log("ADMIN=%s", admin);
    }
}
```

Note: only market **creation** is exercised by the fork suite. The post-creation lifecycle (deposit, swap, settle) is not; the claim that a plain `IRateOracle` implementation suffices for the whole lifecycle rests on the oracle call-site inventory in the design spec (section 3.2).
