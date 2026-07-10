# Implementation Prompt: Permissionless Market Creation Wrapper + Fixed-Rate Oracle Factory

**How to run (instructions for the main session):** spin up **one agent** with everything below this line, verbatim.

---

You are implementing a three-contract system in the Foundry repo at `/Users/zian/Projects/cork-lop-market-creator-hackathon`. The **source of truth** is the validated design spec at `docs/superpowers/specs/2026-07-09-lop-market-creator-design.md` — read it in full before writing code. Where this prompt and the spec disagree, the spec wins; flag the disagreement in your report.

**System summary.** Cork markets get created permissionlessly through a thin wrapper. Three contracts: `FixedRateOracle` (immutable rate, implements Cork's `IRateOracle`), `FixedRateOracleFactory` (CREATE2 get-or-deploy keyed by rate), `CorkMarketCreator` (single permissionless `createMarket(CreateParams)` entry point: gets/deploys the oracle via the factory, no-ops if the market already exists, otherwise creates the Cork pool through `DefaultCorkController.createNewPool`). The wrapper holds `POOL_CREATOR_ROLE` on the controller; the wrapper itself restricts nobody. Deployment target: shadow Phoenix deployment on Arbitrum One. There is NO 1inch integration — no pre-interaction hook, no order machinery.

**Hard conventions (non-negotiable):**
- Solidity: pin `solc = "0.8.30"` in `foundry.toml`; `pragma solidity ^0.8.30;` everywhere.
- Run `forge build` after EVERY contract change; fix errors immediately.
- Every `vm.expectRevert` MUST use a proper error selector (e.g. `vm.expectRevert(IRateOracle.InvalidRate.selector)`). Never a bare `vm.expectRevert()`.
- The shipped repo must have NO dependency on the private `phoenix-private` repo — all Cork types are vendored minimal interfaces under `src/interfaces/`.
- Git commits: concise conventional messages. NEVER add a `Claude-Session:` trailer or any `https://claude.ai/code/...` link.

**Vendored interface facts (validated against phoenix commit `0c22c5d3` / v1.1.2 by compile-proof — trust these over intuition):**

```solidity
type MarketId is bytes32;

struct Market {                    // FIELD ORDER IS LOAD-BEARING: MarketId = keccak256(abi.encode(market))
    address collateralAsset;       // first (a getId natspec in phoenix lists referenceAsset first — that natspec is WRONG)
    address referenceAsset;
    uint256 expiryTimestamp;
    uint256 rateMin;
    uint256 rateMax;
    uint256 rateChangePerDayMax;
    uint256 rateChangeCapacityMax;
    address rateOracle;
}

interface IPoolManager {
    function getId(Market calldata marketParameters) external view returns (MarketId marketId); // impl is pure; declare view to match phoenix interface
    function market(MarketId poolId) external view returns (Market memory parameters);          // returns ALL-ZERO struct for unknown markets (its phoenix natspec claims it reverts — it does NOT)
}

struct PoolCreationParams {        // FOOTGUN: unwind fee comes BEFORE swap fee — always construct with NAMED FIELDS
    Market pool;
    uint256 unwindSwapFeePercentage; // 1e18 = 1%; max 5e18 (5%) enforced at creation
    uint256 swapFeePercentage;       // 1e18 = 1%; max 5e18 (5%) enforced at creation
    bool isWhitelistEnabled;
}

interface IDefaultCorkController {
    function createNewPool(PoolCreationParams calldata params) external; // gated by POOL_CREATOR_ROLE = keccak256("POOL_CREATOR_ROLE")
}
```

- `IRateOracle`: vendor ONLY the `IRateOracle` interface from phoenix's `contracts/interfaces/IRateOracle.sol` — errors `InvalidRate()`, `ZeroAddress()`; `function rate() external view returns (uint256);` (1 Reference Asset quoted in Collateral Asset, scaled 1e18). STRIP `IComposableRateOracle` and the `MinimalAggregatorV3Interface` import — validated as safe: `rate()` is the only method phoenix ever calls on a market's oracle.
- Selector-collision warning: phoenix's `IErrors.InvalidRate()` (controller/pool-manager reverts) and `IRateOracle.InvalidRate()` have the SAME signature and selector — fine at runtime, but be deliberate about which interface you import in tests.

**Phoenix creation-validation facts (what reverts a `createNewPool`):** token decimals above 18 (no lower bound); `rateMin == 0`; `rateMin >= rateMax` (STRICT `<` required); oracle `rate()` outside `[rateMin, rateMax]` at bootstrap (bootstrap runs synchronously inside creation); either fee above `5e18`; zero/equal asset addresses. `rateChangePerDayMax` / `rateChangeCapacityMax` are unvalidated — zero is accepted.

**Confirmed fixed-rate parameter recipe** (for docs and test fixtures): `rateMin = rate`, `rateMax = rate + 1`, `rateChangePerDayMax = 0`, `rateChangeCapacityMax = 0`. With a fixed oracle the constraint adapter early-returns on zero change, so the adjusted rate equals the oracle rate for the market's whole life.

**CREATE2 recipe (validated by fuzz):** salt = `bytes32(rate)`; init-code hash = `keccak256(abi.encodePacked(type(FixedRateOracle).creationCode, abi.encode(rate)))` — constructor args MUST be appended to creationCode; predicted address via the standard `0xff` preimage (`keccak256(abi.encodePacked(bytes1(0xff), factory, salt, initCodeHash))`).

## Tasks

1. **Scaffold.** The repo currently contains only `docs/` and `.git`. Initialize Foundry in place (`forge init --force` or manual layout): `src/`, `test/`, `script/`, `foundry.toml` (solc 0.8.30, optimizer on). Remove template Counter files. Add a `.gitignore` for `out/`, `cache/`, `broadcast/`.

2. **Vendor interfaces** under `src/interfaces/`: `IRateOracle.sol` (stripped as specified above), `IPoolManager.sol`, `IDefaultCorkController.sol` — exactly per the definitions above. Nothing else; no 1inch files.

3. **`src/FixedRateOracle.sol`** — implements `IRateOracle`. `constructor(uint256 rate_)`: revert with `IRateOracle.InvalidRate()` if `rate_ == 0`; store in an immutable. `rate()` returns it. Natspec: state the meaning (1 REF quoted in CA, 1e18) and that the value is fixed forever — intended for short-lived (~24h) markets. Nothing else: no owner, no setters.

4. **`src/FixedRateOracleFactory.sol`** —
   - `getOrDeploy(uint256 rate) external returns (address oracle)`: compute the deterministic address; if it has code, return it; else deploy `new FixedRateOracle{salt: bytes32(rate)}(rate)` and emit `OracleDeployed(uint256 indexed rate, address indexed oracle)`.
   - `computeAddress(uint256 rate) public view returns (address)`: the CREATE2 recipe above.
   - No admin surface. A zero rate should revert with the oracle's `InvalidRate` (bubbling from the constructor is acceptable; a pre-check in the factory is also fine — pick one and test it by selector).

5. **`src/CorkMarketCreator.sol`** — the permissionless wrapper.
   - Immutables set in the constructor: `IDefaultCorkController controller`, `IPoolManager poolManager`, `FixedRateOracleFactory oracleFactory`. Revert on any zero address (named error, e.g. `ZeroAddress`).
   - ```solidity
     struct CreateParams {
         address collateralAsset;
         address referenceAsset;
         uint256 expiryTimestamp;
         uint256 rate;
         uint256 rateMin;
         uint256 rateMax;
         uint256 rateChangePerDayMax;
         uint256 rateChangeCapacityMax;
         uint256 swapFeePercentage;
         uint256 unwindSwapFeePercentage;
         bool    isWhitelistEnabled;
     }
     ```
   - `createMarket(CreateParams calldata params) external` — the only entry point. NO caller restriction — document in natspec that this is deliberate (creation is permissionless and idempotent).
   - Flow (mirror spec §3.4 exactly):
     a. `address oracle = oracleFactory.getOrDeploy(params.rate);`
     b. Build the `Market` struct with named fields (`rateOracle: oracle`); `MarketId id = poolManager.getId(market);`
     c. Existence check: `Market memory existing = poolManager.market(id);` exists when `existing.collateralAsset != address(0) && existing.referenceAsset != address(0)`. If exists → `emit MarketAlreadyExists(id);` return. (This no-op path is what makes creation races and repeat calls safe.)
     d. Create branch only (AFTER the existence check — placement is load-bearing, see spec §3.4 placement rule): `require(block.timestamp < params.expiryTimestamp)` reverting with named error `MarketExpiryInPast()`. Then `controller.createNewPool(PoolCreationParams({pool: market, unwindSwapFeePercentage: params.unwindSwapFeePercentage, swapFeePercentage: params.swapFeePercentage, isWhitelistEnabled: params.isWhitelistEnabled}));` — NAMED fields, the unwind/swap order footgun is real. Then `emit MarketCreated(id, oracle, params.collateralAsset, params.referenceAsset, params.expiryTimestamp, params.rate);`
   - Events: `MarketCreated(MarketId indexed id, address oracle, address collateralAsset, address referenceAsset, uint256 expiryTimestamp, uint256 rate)`; `MarketAlreadyExists(MarketId indexed id)`.
   - No owner, no admin, no upgradeability.

6. **Unit tests** (`test/FixedRateOracle.t.sol`, `test/FixedRateOracleFactory.t.sol`, `test/CorkMarketCreator.t.sol`). Creator tests use lightweight mocks of the controller + pool manager (the mock pool manager stores created markets so the existence check exercises both branches):
   - Oracle returns the constructor rate; zero rate reverts with the `InvalidRate` selector.
   - `computeAddress(rate)` equals the actual deployed address — concrete case AND a fuzz over `rate` (bound rate != 0).
   - `getOrDeploy` called twice with the same rate returns the same address, deploys once; distinct rates → distinct addresses; `OracleDeployed` event emitted with correct fields on fresh deploy only.
   - `createMarket` → controller called once with a correctly assembled `PoolCreationParams` (assert EVERY field, especially that unwind/swap fees land in the right slots).
   - Already-exists → no controller call, `MarketAlreadyExists` emitted, no revert.
   - Past expiry on the create branch → `MarketExpiryInPast` selector; past expiry on an EXISTING market → still no-op, no revert (spec §6).
   - Controller revert bubbles up (mock it reverting with phoenix's `AlreadyInitialized()` / `InvalidParams()` selectors and assert propagation).
   - Constructor zero-address reverts by selector.

7. **Arbitrum fork test** (`test/fork/CorkMarketCreator.fork.t.sol`, gated on `vm.envOr("ARBITRUM_RPC_URL", string(""))` being nonempty — skip cleanly otherwise). Address inputs via environment variables (`CONTROLLER`, `POOL_MANAGER`, `ADMIN`). Contingency per spec §8.3: if shadow-deployment addresses are unavailable, clone phoenix-private OUTSIDE this repo and deploy a throwaway stack on the fork instead; if that is also impractical in the timebox, mark the fork test skipped and say so loudly in your report — do NOT fake it.
   - Setup: fork Arbitrum; `vm.prank(admin); controller.grantRole(POOL_CREATOR_ROLE, creator)`.
   - Happy path: `createMarket` with the confirmed recipe → market exists (`poolManager.market(id)` populated), `MarketCreated` emitted, oracle at the precomputed address.
   - Repeat call with identical params → `MarketAlreadyExists`, no revert.
   - Invalid params (oracle rate outside `[rateMin, rateMax]`) → phoenix revert bubbles to the caller.
   - Front-run case: attacker `createMarket`s the victim's `Market` fields with different fees first; victim's call emits `MarketAlreadyExists`; assert the stored configuration differs from the victim's intended fees.
   - Fee read-back: after creation, read the pool's stored swap fee and assert it equals the intended percentage (catches the silent 100x scale failure).
   - Post-expiry: warp past `expiryTimestamp`, call again with identical params → no-op.

8. **Deploy script** (`script/Deploy.s.sol`): reads `CONTROLLER`, `POOL_MANAGER` env vars; deploys `FixedRateOracleFactory`, then `CorkMarketCreator(controller, poolManager, factory)`; logs both addresses AND the exact cast command / calldata for the admin's `grantRole(POOL_CREATOR_ROLE, <creator>)` call.

9. **Integration doc** (`docs/integration.md`) — written for Bond's agent developers, standalone (no Cork source access assumed). Content = spec §4 made concrete: choosing params (with the confirmed fixed-rate recipe and the phoenix validation list above), precomputing the oracle address and MarketId off-chain, the pre-send `eth_call` simulation recommendation, the first-writer-wins warning on fees/whitelist (spec §3.5) and the advice to create early to be the first writer, the one-time creation gas note, deployed addresses section (placeholder until deployment).

10. **Gate:** `forge build` clean; all unit tests green; fork test green under contingency rung 1 or 2 (or loudly reported as skipped under rung 3); everything committed with sensible splits (e.g. `feat: fixed-rate oracle and CREATE2 factory`, `feat: permissionless cork market creator`, `test: arbitrum fork test`, `docs: bond integration guide`).

**Report format:** end your work with: what you built (file list), `forge build` + `forge test` output summary (counts, not full logs), any deviation from the spec with justification, and the commit hash(es).
