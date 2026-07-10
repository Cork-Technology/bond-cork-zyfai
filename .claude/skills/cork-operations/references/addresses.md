# Addresses — the single address book

<!-- Sources of truth: Slack live-deployment announcement (2026-07-10), contracts/docs/integration.md,
     contracts/script/Deploy.s.sol, contracts/docs/examples/lib.mjs (LOP_ADDRESS), contracts/docs/fork-testing.md. -->

Chain: **Arbitrum One, chain id 42161**. Everything below is LIVE and Arbiscan-verified, on the
**SHADOW Phoenix instance** — distinct CREATE2 salts, fully isolated from canonical Phoenix;
pilot/hackathon scope, all timelock delays 0. These are the defaults for every recipe in this
skill; no other skill file carries an address.

## This repo's contracts (live)

| Contract | Address |
|---|---|
| `CorkMarketCreator` | `0x4B5B91cF4d1DAdb7439beB68926c86D2D8C68dBC` |
| `FixedRateOracleFactory` | `0x1050e67e37447e0D5686B3ee972a2c6dDB433295` |
| `CorkLimitOrderAdapter` (JIT minting) | `0xc915B0776189E5Fa021C60D76Da0c8D7F1997801` |
| 1inch Limit Order Protocol v4 (inside Aggregation Router v6) | `0x111111125421cA6dc452d289314280a0f8842A65` (canonical, unchanged) |

Live operational facts:

- `POOL_CREATOR_ROLE` is ALREADY granted to `CorkMarketCreator` — market creation is
  permissionless on the live instance, no role-grant step. (The grant recipe below matters
  only on a local throwaway stack.)
- The adapter needs no wiring — stateless and permissionless; it is only referenced from
  order extensions and fill args.
- Markets that will carry JIT orders MUST be created with `isWhitelistEnabled: false` —
  Phoenix gates `mint` by the per-market whitelist and the adapter is the `msg.sender`.

## Shadow Phoenix core stack (live)

| Contract | Address |
|---|---|
| `CorkPoolManager` | `0xc2De56fb1C7a85250ce69C37B4773767C77954AE` |
| `DefaultCorkController` | `0x8974fF6ef0eFCc143C01C6A596b026FdEB9Ff350` |
| `CorkAdapter` | `0x5989761D6a567C16480Bc5ce2989492777532646` |
| `WhitelistManager` | `0x6611676F84A25914Ce4A4B7866739E5cb70eAf42` |
| `ConstraintRateAdapter` | `0x798CB4Bd8066BAeF149Cf89AED71507B334bF20E` |
| `SharesFactory` | `0x48d8e4dE8731C3583ddA7Aa617a88C7F484AeB8e` |

Governance (pilot scope): M0 upgrade authority + M1 controller admin are collapsed into one
Cork Safe, `0xd6b9D31A442c5421816c5a95E310abFa0Af88a89`; the M2 operational Safe (markets,
fees, whitelist) is `0x7ef5645c930122bf587e45d814ecd6f92dac41fc`; the emergency pauser
(instant, no timelock) is `0x7e57CCf8199d2d5561f370FC4d13C82aCbcbA0c2`.

Cork Phoenix API base URL: **`https://api-phoenix.cork.tech`** (all endpoints under `/v1`);
interactive API docs at **`https://api-phoenix.cork.tech/docs`**.

## Fork testing — the local throwaway stack

The live addresses above are the default. For isolated testing, everything also runs on an
anvil fork of Arbitrum One (the real 1inch protocol is already at its canonical address on
any fork):

1. **Phoenix stack** — follow `contracts/docs/fork-testing.md` Option B exactly: start
   `anvil --fork-url <arbitrum-rpc> --port 8545 --disable-code-size-limit`, then run
   `ThrowawayDeploy.s.sol` from a phoenix-private clone. It prints `CONTROLLER`,
   `POOL_MANAGER`, `ADMIN`. The admin is the script's broadcaster (`THROWAWAY_PK` — anvil's
   default account 0); that same key is `<admin-pk>` in the next step.
2. **This repo's contracts** — from the repo root:
   `CONTROLLER=... POOL_MANAGER=... LOP=0x111111125421cA6dc452d289314280a0f8842A65 forge script contracts/script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <admin-pk>`
   It prints the factory, creator, and adapter addresses, plus the
   `grantRole(POOL_CREATOR_ROLE, creator)` call the admin must then send on the controller.
   The printed `cast send` is a template, not literally runnable: replace
   `--rpc-url $ARBITRUM_RPC_URL --from <admin>` with
   `--rpc-url http://127.0.0.1:8545 --private-key <admin-pk>` (`--from` does not sign).
   Without that grant, `createMarket` reverts — on the throwaway stack only; the live
   creator already holds the role.
3. **Test tokens** — deploy two ERC-20s as CA and REF: non-rebasing, at most 18 decimals,
   different, nonzero — and they MUST implement `name()` and `symbol()`: phoenix's
   `SharesFactory` calls `symbol()` on both assets during pool creation, and a token without
   it makes `createMarket` revert with NO error data. The repo's `JITMocks.sol:MockERC20`
   lacks `symbol()` — do not use it here; write a minimal ERC-20 with
   `name/symbol/decimals/balanceOf/transfer/approve/transferFrom` + an open `mint`, deploy it
   with `forge create` (note `--constructor-args` must be the LAST flag), and mint to your
   actors.

The live API cannot see a local fork's state — on a bare fork use the file-handoff discovery
mode described in `references/limit-orders.md` and direct viem reads instead of the API.
