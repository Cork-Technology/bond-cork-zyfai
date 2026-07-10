# Design: Permissionless Cork Market Creation Wrapper + Fixed-Rate Oracle Factory

- **Date:** 2026-07-09
- **Status:** Approved. **Scope reduced 2026-07-09 (later the same day):** the 1inch Limit Order Protocol pre-interaction integration is dropped. What remains is the thin permissionless wrapper that creates markets by calling the Cork controller directly, plus the fixed-rate oracle and its factory. The original 1inch design is preserved in git history at commit `e7c466a`.
- **Deliverable of the next phase:** one implementation prompt — see §9.

## 1. Context and goal

For the Bond.credit / Zyf.ai hackathon (starts Friday 2026-07-10, Arbitrum Founders House), Cork needs:

1. A **permissionless wrapper contract** that creates Cork markets by calling `DefaultCorkController.createNewPool`. The controller gates creation behind `POOL_CREATOR_ROLE`; the wrapper holds that role and imposes no caller restriction of its own, so anyone (in practice: the agents) can create markets through it.
2. A **fixed-rate ("hardcoded") oracle** and an **oracle factory** adhering to the `IRateOracle` interface from `phoenix-private` (`rate()` only — the composable interface `IComposableRateOracle` is explicitly out of scope).

Background decisions from the Slack channel `#prod-agentic-defi` (C0BGM9GAVNU):

- Agents cooperate in minutes, so markets can be very short-lived (~24 hours), which makes a **fixed oracle rate hardcoded at deployment** acceptable and greatly simplifies market creation.
- Architecture endorsed in-channel: "a thin permissionless wrapper contract that we use for actually deploying the market" plus per-market tooling (skill) on top. This spec is now exactly that and nothing more.
- Target: **shadow deployment of Phoenix on Arbitrum**. Vault shares must satisfy Phoenix token requirements (non-rebasing; token decimals at most 18 — the confirmed phoenix guard, no lower bound; see §10).

## 2. Decisions made in this session

| Decision | Choice |
|---|---|
| Repo | **New standalone private repo** (`cork-lop-market-creator-hackathon`; name predates the scope cut). No dependency on `phoenix-private`; minimal interfaces vendored. |
| Cork entry point | **`DefaultCorkController.createNewPool(PoolCreationParams)`**, with the wrapper holding `POOL_CREATOR_ROLE` (least privilege: creation + initial fees only). Rejected: `CORK_CONTROLLER_ROLE` on `CorkPoolManager` (also gates pausing, treasury, shares factory). |
| 1inch integration | **Dropped (2026-07-09 scope cut).** No pre-interaction hook, no order-extension encoding, no router-driven creation. Agents call `createMarket` directly. |
| Oracle flow | **Wrapper deploys via factory (get-or-deploy, CREATE2 keyed by rate)**. `CreateParams` carries the rate, not an oracle address. Deterministic, precomputable off-chain, guaranteed provenance. |
| Already-exists behavior | **No-op if the market exists** (emit event, return). Creation is permissionless, so two agents can race to create the same market; the loser's call must not revert. This also keeps `createMarket` safely retryable. |
| Guardrails | **None for now.** Parameters pass through as supplied. No duration cap, no asset allowlist, no derived rate bounds, no fee defaults. |
| Caller policy | **No `msg.sender` restriction** on `createMarket`. Creation is permissionless and idempotent. |
| Packaging | One implementation prompt, one agent — see §9. |

Rejected alternative (architecture level): having agents pre-deploy oracles and a role-granted off-chain keeper call the controller — reintroduces a trusted off-chain actor.

## 3. Architecture

Three contracts. Solidity `^0.8.30` (matches phoenix). Foundry project.

```
Agent (any EOA or contract — no restriction)
        │  createMarket(CreateParams)
        ▼
CorkMarketCreator ──── getOrDeploy(rate) ───▶ FixedRateOracleFactory ── CREATE2 ──▶ FixedRateOracle
        │                                                                            (immutable rate)
        │  createNewPool(PoolCreationParams)          [holds POOL_CREATOR_ROLE]
        ▼
DefaultCorkController ──▶ CorkPoolManager (pool state, share tokens, ConstraintRateAdapter.bootstrap)
```

### 3.1 Vendored interfaces (`src/interfaces/`)

- `IRateOracle` — copied verbatim from `phoenix-private/contracts/interfaces/IRateOracle.sol` (the `IRateOracle` interface only: errors `InvalidRate`, `ZeroAddress`; function `rate() external view returns (uint256)` = value of 1 Reference Asset quoted in Collateral Asset, scaled by 1e18).
- `IDefaultCorkController` — `PoolCreationParams { Market pool; uint256 unwindSwapFeePercentage; uint256 swapFeePercentage; bool isWhitelistEnabled; }` and `createNewPool(PoolCreationParams)`.
- `IPoolManager` — the `MarketId` type (`type MarketId is bytes32`), the `Market` struct (field order is load-bearing for the id hash: `collateralAsset`, `referenceAsset`, `expiryTimestamp`, `rateMin`, `rateMax`, `rateChangePerDayMax`, `rateChangeCapacityMax`, `rateOracle`), `getId(Market) view returns (MarketId)` (declare `view` to match the phoenix interface even though the implementation is `pure`), and the existence probe `market(MarketId) view returns (Market memory)` (§8.1 — resolved).

No 1inch interfaces are vendored.

### 3.2 FixedRateOracle

- `constructor(uint256 rate_)`: reverts `InvalidRate()` if `rate_ == 0`; stores as immutable.
- `rate() external view returns (uint256)`: returns the immutable value.
- No owner, no setters, nothing else. Phoenix's `ConstraintRateAdapter` casts oracles to the composable type but only ever calls `rate()`, so a plain `IRateOracle` implementation works. **CONFIRMED by call-site inventory at the pinned phoenix commit (§10):** every read of a market's stored `rateOracle` funnels through exactly one function, `ConstraintRateAdapter._fetchRate` (ConstraintRateAdapter.sol:190–192), which calls only `rate()`. It is reached from three places, all in the adapter: `bootstrap` (line 100, once at creation), `adjustedRate` (line 115, every swap/exercise/unwind), and `previewAdjustedRate` (line 154, all view paths). Expiry/settlement paths (`previewRedeem`, `_previewWithdraw`) never touch the oracle. The Chainlink data-feed library in the repo (`ChainlinkDataFeedLib.sol`) has zero call sites — dead code. No code path ever calls the `MinimalAggregatorV3Interface` members on a market's oracle; the only residual risk is a future upgrade of the (upgradeable) adapter itself.

### 3.3 FixedRateOracleFactory

- `getOrDeploy(uint256 rate) returns (address oracle)`: CREATE2 with `salt = bytes32(rate)`. If the deterministic address already has code, return it; otherwise deploy and emit `OracleDeployed(rate, oracle)`.
- `computeAddress(uint256 rate) view returns (address)`: off-chain precomputation for agents.
- One oracle per distinct rate, shared across markets. No admin surface.

### 3.4 CorkMarketCreator (the wrapper)

Immutables at deployment: `controller` (DefaultCorkController), `poolManager` (CorkPoolManager), `oracleFactory`.

```solidity
struct CreateParams {
    address collateralAsset;
    address referenceAsset;
    uint256 expiryTimestamp;
    uint256 rate;                    // fixed oracle rate, 1e18-scaled, REF quoted in CA
    uint256 rateMin;                 // creation requires rateMin > 0 AND rateMin < rateMax (STRICT); bootstrap requires rateMin <= rate <= rateMax. Recipe: rateMin = rate
    uint256 rateMax;                 // recipe: rate + 1 (smallest value passing the strict check)
    uint256 rateChangePerDayMax;     // unvalidated by phoenix; use 0 for a fixed rate (freezes drift even if the oracle wobbled)
    uint256 rateChangeCapacityMax;   // unvalidated by phoenix; use 0 for a fixed rate
    uint256 swapFeePercentage;       // CONFIRMED scale: 1e18 = 1% (divided by 100e18 in MathHelper); max 5e18 (5%) enforced at creation
    uint256 unwindSwapFeePercentage; // same scale and 5e18 cap. FOOTGUN: PoolCreationParams field order is (pool, UNWIND, swap, whitelist) — always construct with named fields
    bool    isWhitelistEnabled;
}
```

Single entry point:

- `createMarket(CreateParams calldata params) external` — permissionless, no caller restriction (documented in natspec as deliberate).

Flow of `createMarket`:
1. `address oracle = oracleFactory.getOrDeploy(params.rate);`
2. Build `Market` struct with `rateOracle = oracle`; `MarketId id = poolManager.getId(market);`
3. Existence check (resolved, §8.1): `Market memory existing = poolManager.market(id);` — the market exists when `existing.collateralAsset != address(0) && existing.referenceAsset != address(0)` (the mirror of phoenix's own `PoolLibrary.isInitialized` predicate). If it exists → emit `MarketAlreadyExists(id)`, return (idempotent no-op). `market()` returns an all-zero struct for unknown markets; its natspec claims it reverts, which is wrong — do not trust the natspec, and no try/catch is needed.
4. Else `controller.createNewPool(PoolCreationParams(market, params.unwindSwapFeePercentage, params.swapFeePercentage, params.isWhitelistEnabled));` emit `MarketCreated(id, oracle, params.collateralAsset, params.referenceAsset, params.expiryTimestamp, params.rate)`.

Placement rule for cheap parameter checks: a `require(block.timestamp < params.expiryTimestamp)` with a named selector (for example `MarketExpiryInPast`) belongs **only** on the create branch (step 4, market does not yet exist) — not before the existence check, because there it would turn a retry against an already-created market that has since passed its expiry into a revert instead of the promised no-op. Only time-invariant checks (zero address, equal assets, rate outside `[rateMin, rateMax]`) are safe before the existence check.

No owner, no admin functions, no upgradeability.

### 3.5 Market identity vs. creation parameters

Market identity is exactly the `Market` struct fields: assets, expiry, rate bands, and oracle (`collateralAsset`, `referenceAsset`, `expiryTimestamp`, `rateMin`, `rateMax`, `rateChangePerDayMax`, `rateChangeCapacityMax`, `rateOracle`). `MarketId` is the hash of that struct and nothing else. The `PoolCreationParams` fields `swapFeePercentage`, `unwindSwapFeePercentage`, and `isWhitelistEnabled` are **not** part of identity: they are fixed by whoever creates the market first (first-writer-wins). A later `CreateParams` with the same `Market` fields but different fees or whitelist setting hits the idempotent no-op path and inherits the first creator's configuration.

## 4. Data flow — agent's perspective (basis for the Bond docs)

1. Choose market parameters. Off-chain: `oracle = factory.computeAddress(rate)`; build the `Market` struct; `marketId = keccak256(abi.encode(market))` — all computable before sending any transaction. Confirmed default recipe for the rate-band and clamp fields of a fixed-rate market: `rateMin = rate`, `rateMax = rate + 1`, `rateChangePerDayMax = 0`, `rateChangeCapacityMax = 0`. Reasoning (source-verified at the pinned phoenix commit, §10): creation requires `rateMin > 0` and strictly `rateMin < rateMax`, so the naive `rateMin = rateMax = rate` is REJECTED; the two rate-change fields are unvalidated anywhere, and zero freezes all movement; with a fixed oracle the constraint adapter early-returns on zero rate change, so the adjusted rate equals the oracle rate for the market's whole life regardless of the clamp fields.
2. Simulate before sending: run `eth_call` against `createMarket(params)` as a read-only simulation. A garbage `CreateParams` fails with a deep, hard-to-read phoenix selector; the simulation surfaces the error before gas is spent. Cheap on-chain requires for time-invariant invariants (zero address, equal assets, rate outside `[rateMin, rateMax]`) are optional; if added, they follow the placement rule in §3.4 (only time-invariant checks run before the existence check).
3. Send `createMarket(params)`. On success either `MarketCreated` fires (you created it) or `MarketAlreadyExists` fires (someone else got there first — verify the stored fee/whitelist configuration matches what you intended before relying on it, per §3.5 first-writer-wins).
4. The first creation of a market pays the one-time gas for the oracle deploy (if that rate is new), pool creation, and bootstrap; a repeat call pays only the existence check.

## 5. Access control and deployment

- One privileged wiring step on the shadow deployment: admin grants `POOL_CREATOR_ROLE` on `DefaultCorkController` to the deployed `CorkMarketCreator` (on production topology this goes through the operational timelock; on the shadow deployment it is a direct grant by the admin). This contract must not be granted `POOL_CREATOR_ROLE` on any production topology without the guardrails deferred in §2.
- Deploy script (forge script): deploy `FixedRateOracleFactory` → deploy `CorkMarketCreator(controller, poolManager, factory)` → print the `grantRole` call for the admin.
- Shadow-deployment addresses on Arbitrum are deploy-time inputs.

## 6. Error handling

| Situation | Behavior |
|---|---|
| Rate of 0 at oracle deploy | Revert `InvalidRate()` (selector from `IRateOracle`) |
| Oracle for rate already deployed | Factory returns existing address (no revert) |
| Market already exists (race, repeat call, front-run creation) | No-op + `MarketAlreadyExists` event. Fees and `isWhitelistEnabled` are first-writer-wins and are **not** part of `MarketId` (§3.5), so the market carries whatever fee/whitelist configuration the first creator chose |
| Invalid market params (zero/equal assets; token decimals above 18 — confirmed guard, no lower bound; past expiry; `rateMin` zero or not strictly below `rateMax`; oracle rate outside `[rateMin, rateMax]` at bootstrap; fees above the 5% cap `5e18`) | Phoenix reverts; revert bubbles up to the caller — intentional: if the market cannot exist, the caller must find out |
| `createMarket` for a market that exists but has passed its expiry | No-op + `MarketAlreadyExists`. The existence check runs first, so market expiry never turns an existing market's no-op into a revert (placement rule, §3.4) |

## 7. Testing

- **Unit (local):**
  - Oracle: returns constructor rate; zero rate reverts with `InvalidRate` selector.
  - Factory: deterministic address, `computeAddress` parity with actual deploy, get-or-deploy idempotency, event emission.
  - Creator: `createMarket` → creation call with correctly assembled structs (mocked controller/pool manager; assert every `PoolCreationParams` field, especially that the unwind and swap fees land in the right slots), no-op path, revert propagation, expiry check on the create branch only.
- **Fork (Arbitrum):** against the shadow deployment — `vm.prank` the admin to grant `POOL_CREATOR_ROLE`, then call `createMarket` directly. Cases:
  - Happy path: market exists afterwards (`poolManager.market(id)` populated), `MarketCreated` emitted, oracle deployed at the precomputed address.
  - Repeat call with identical params → `MarketAlreadyExists`, no revert, no state change.
  - Front-run case: an attacker calls `createMarket` with the victim's `Market` fields but different fees/whitelist first; assert **both** that the victim's call emits `MarketAlreadyExists` and that the stored market configuration differs from the victim's `CreateParams`.
  - Fee read-back: after creation, read the pool's stored swap fee and assert it equals the intended percentage (catches a silent 100x scale failure).
  - Post-expiry: warp past the market's `expiryTimestamp` and call again with identical params; assert the no-op behavior specified in §6.
  - Lifecycle beat: if it fits the timeline, extend the fork test one lifecycle beat past creation (deposit, warp to expiry, settle) and assert no revert. If it does not fit, record that only creation is exercised and that the lifecycle claim rests on the §3.2 call-site inventory.
- Conventions (mandatory): every `vm.expectRevert` uses a proper error selector; run `forge build` after every contract change.

## 7.1 Success criteria (testable)

1. `forge build` compiles the repo cleanly with Solidity `^0.8.30` and no dependency on `phoenix-private` sources.
2. All unit tests in §7 pass, with every expected revert asserted by error selector.
3. The Arbitrum fork test passes: `createMarket` creates a real market on the shadow deployment; a repeat call hits the `MarketAlreadyExists` no-op path; the fee read-back matches.
4. `factory.computeAddress(rate)` equals the address actually deployed by `getOrDeploy(rate)` for the same rate, on-chain and as computed off-chain in the fork test.
5. The deploy script deploys both contracts from three address inputs and prints the exact `grantRole(POOL_CREATOR_ROLE, creator)` call.
6. The agent-integration doc (§4) is complete enough that a third party (Bond) can call `createMarket` with valid parameters without reading the contract source.
7. The front-run fork-test case (§7) passes: the victim's call emits `MarketAlreadyExists` and the test asserts the stored fee/whitelist configuration differs from the victim's `CreateParams`.

## 8. Open items

### 8.1 Market-existence view — RESOLVED (validation worktree, 2026-07-09)
There is no dedicated `isInitialized(MarketId)` view on `CorkPoolManager`, and no try/catch is needed. The existence probe is `market(MarketId) external view returns (Market memory)` (CorkPoolManager.sol:146–149), which returns an **all-zero struct** for a non-existent market — its natspec ("reverts if market has not been initialized") is wrong; the implementation has no such check. The check mirrors phoenix's own predicate (`PoolLibrary.isInitialized`, PoolLib.sol:665–667): the market exists when both `collateralAsset` and `referenceAsset` are nonzero. For reference only, the duplicate-creation revert path is `AlreadyInitialized()` (IErrors.sol:32, selector `0x0dc149f0`, raised at CorkPoolManager.sol:117 — and, when `isWhitelistEnabled = true`, earlier at WhitelistManager.sol:193); the creator's own existence check runs first, so it never reaches either.

### 8.2 Repo name
`cork-lop-market-creator-hackathon` predates the scope cut; the "lop" part is now historical. Rename freely.

### 8.3 Shadow-deployment addresses
Needed at deploy time (controller, pool manager, admin). Baptiste was deploying Cork contracts on Arbitrum 2026-07-08/09.

**Contingency (trigger: addresses not confirmed and pinned here by Thursday end of day, 2026-07-09):** clone `phoenix-private` **outside** the shipped repo and deploy a throwaway Phoenix instance on a local Arbitrum fork, satisfying success criteria 3–4 without adding a dependency to the shipped repo. If neither the shadow deployment nor the local-fork fallback is ready, the fork test is descoped to post-hackathon, the mocked unit suite (§7) becomes the gating demonstration, and criteria 3–4 move to this section as open items.

**Action:** draft a Slack message to confirm Baptiste's deployment status and submit it for the user's approval today (draft for approval — do not send without it).

### 8.4 Optional read-back-and-revert on fee/whitelist mismatch
If a getter for a market's stored fees/whitelist is confirmed, the team can decide to have `createMarket` read the stored configuration back on the already-exists path and revert on a mismatch with the supplied `CreateParams`. Taking that option supersedes the "no-op never reverts" contract in §2 and §8.1: it changes the no-op behavior to "revert on a mismatched pre-existing market". The default in this spec stays: documentation (§3.5, §4 step 3) plus the §7 front-run test; the no-op does not revert.

## 9. Plan packaging (handoff contract)

- **One implementation plan** (`docs/superpowers/plans/2026-07-09-lop-market-creator-plan.md`).
- **One prompt, one agent** (`docs/superpowers/prompts/2026-07-09-lop-market-creator-prompt.md`): scaffold + vendored interfaces + all three contracts + unit tests + fork test + deploy script + integration doc. The earlier two-sub-prompt split existed to sequence the 1inch work; with that gone, one agent covers the whole scope.
- Per global workflow convention, prompts are frozen only against validated assumptions. The **throwaway-worktree validation pass ran 2026-07-09** against the original (superset) design: 28 files, solc 0.8.30, clean `forge build`, 5/5 tests green — including the `CreateParams` encode/decode round-trip, CREATE2 `computeAddress` parity with a 256-run fuzz, zero-rate revert by selector, and the end-to-end create flow against mocks with a second-create no-op. Every assumption the simplified scope relies on (controller call shape, struct layouts, existence probe, rate-band recipe, fee scale, decimals bound, oracle call-site inventory) was validated in that pass; the scope cut removes assumptions (all 1inch mechanism facts) and adds none, so the validation carries over and no new worktree pass is required.

## 10. Source references

- `phoenix-private` — **pinned commit `0c22c5d3` (origin/main, "v1.1.2 (#526)")**, local clone `/Users/zian/Projects/phoenix-private`. Citations at that commit: `contracts/interfaces/IRateOracle.sol`; `contracts/core/DefaultCorkController.sol` (`createNewPool` + `POOL_CREATOR_ROLE` gate, line 108; role constant, line 39; fee routing, lines 118–119); `contracts/core/CorkPoolManager.sol` (`createNewPool`, line 96; decimals guard, lines 108–109; rate-band validation `rateMin > 0 && rateMin < rateMax`, lines 110–111; `AlreadyInitialized` revert, line 117; `getId`, lines 142–144; `market` view, lines 146–149); `contracts/libraries/PoolLib.sol` (`isInitialized`, lines 665–667; `MAX_ALLOWED_FEES = 5 ether`, lines 44–46; fee-cap enforcement, lines 632 and 647; swap-fee application, line 730); `contracts/libraries/MathHelper.sol` (`calculatePercentageFee` — `mulDiv(fee1e18, 100e18)`, lines 48–50); `contracts/core/ConstraintRateAdapter.sol` (`bootstrap` rate-window check, lines 100–107; `_fetchRate` — the single oracle call site, lines 190–192; `_calculateRate` zero-change early return, lines 201–205); `contracts/interfaces/IPoolManager.sol` (`MarketId`, line 30; `Market`, lines 33–42); `contracts/interfaces/IDefaultCorkController.sol` (`PoolCreationParams`, lines 41–46); `contracts/interfaces/IErrors.sol` (`AlreadyInitialized`, line 32; `InvalidParams`, line 50; `InvalidRate`, line 70); `contracts/core/WhitelistManager.sol` (duplicate-market whitelist revert, line 193).
- Slack `#prod-agentic-defi` (C0BGM9GAVNU), 2026-07-08/09 — requirements and decisions digested in §1.
- Original 1inch pre-interaction design (superseded): this file at git commit `e7c466a`, including the pinned 1inch `limit-order-protocol` tag `4.0.0` references.
