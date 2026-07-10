# CLAUDE.md

## What this repo is

A Foundry (forge) hackathon repo with two deliverables. First, permissionless creation of
Cork markets: anyone calls `CorkMarketCreator.createMarket`, which deploys a `FixedRateOracle`
(rate fixed forever; markets live ~24 hours so that is acceptable) and creates the pool on
Cork's shadow Phoenix deployment on Arbitrum One. Second, an adapter for the 1inch Limit Order
Protocol version 4 (a system for signed, off-chain resting orders filled on-chain) that makes
coverage orders capital-free: `CorkLimitOrderAdapter` performs just-in-time (JIT) minting — it
holds no inventory; inside the protocol's pre-interaction hook (maker side) or taker-interaction
hook (taker side) it pulls collateral from the party being served and mints the Cork Swap Token
(cST, the hedge) plus the Cork Principal Token (cPT) at the moment of the fill. Trading follows
"the ceremony": create market (that on-chain act IS the request for quote) → opening bid →
discovery via the Cork Phoenix API → counter-ask → fill. The viem scripts in `docs/examples/`
encode that ceremony off-chain, one script per move.

## Knowledge graph

Any session that adds, renames, moves, or deletes a file in src/, test/, script/,
or docs/examples/ must update this graph in the same change.

### Contracts
- **CorkMarketCreator** (`src/CorkMarketCreator.sol`) — permissionless `createMarket` wrapper; deploys the oracle, then creates the pool; holds POOL_CREATOR_ROLE
- **CorkLimitOrderAdapter** (`src/CorkLimitOrderAdapter.sol`) — stateless 1inch hook doing just-in-time mints in both maker and taker roles
- **FixedRateOracle** (`src/FixedRateOracle.sol`) — rate fixed forever at deployment, 1e18-scaled, 1 Reference Asset quoted in Collateral Asset
- **FixedRateOracleFactory** (`src/FixedRateOracleFactory.sol`) — deterministic CREATE2 factory keyed by rate; one deploy per rate; `computeAddress` for off-chain precompute

### Interfaces (vendored, minimal)
- **I1inchLimitOrderProtocol** (`src/interfaces/I1inchLimitOrderProtocol.sol`) — 1inch `Order` struct, `AddressLib`, and the two hook interfaces `IPreInteraction`/`ITakerInteraction`
- **IDefaultCorkController** (`src/interfaces/IDefaultCorkController.sol`) — `createNewPool` + `PoolCreationParams` (footgun: unwind fee BEFORE swap fee — use named fields)
- **IPoolManager** (`src/interfaces/IPoolManager.sol`) — `MarketId`/`Market` types (field order is load-bearing for the id hash), `getId`, `market`, `shares`, `previewMint`, `mint`
- **IRateOracle** (`src/interfaces/IRateOracle.sol`) — the single `rate()` method Phoenix calls on a market's oracle

### External systems
- **1inch LOP v4** (external) — the 1inch Limit Order Protocol version 4; sole authorized caller of the adapter's hooks
- **DefaultCorkController** (external) — Cork Phoenix pool-creation entry, gated by POOL_CREATOR_ROLE
- **CorkPoolManager** (external) — Cork Phoenix pool manager; mints are whitelist-gated with the adapter as `msg.sender`
- **Phoenix API** (external) — Cork's indexer/orderbook HTTP API, discovery leg of the ceremony

### Tests & Mocks
- **CorkMarketCreatorTest** (`test/CorkMarketCreator.t.sol`) — unit tests against mocked controller/pool manager, incl. the fee-order footgun
- **CorkLimitOrderAdapterJitTest** (`test/CorkLimitOrderAdapter.jit.t.sol`) — JIT hook unit tests: both roles, auth, USDT-style tokens, no-custody invariants
- **FixedRateOracleTest** (`test/FixedRateOracle.t.sol`) — rate constancy + zero-rate revert
- **FixedRateOracleFactoryTest** (`test/FixedRateOracleFactory.t.sol`) — CREATE2 address parity + repeat-rate revert
- **ERC1271WalletTest** (`test/ERC1271Wallet.t.sol`) — non-fork coverage of the wallet mock's signature validation and execute passthrough
- **PhoenixIntegrationTest** (`test/PhoenixIntegration.t.sol`) — real Phoenix stack via the `lib/phoenix` submodule's `BaseTest`; only the 1inch protocol stays mocked
- **ContractMakerFillForkTest** (`test/fork/ContractMakerFill.fork.t.sol`) — Arbitrum fork: ERC-1271 contract-maker fill against the REAL 1inch protocol, JIT extension attached
- **CorkMarketCreatorForkTest** (`test/fork/CorkMarketCreator.fork.t.sol`) — Arbitrum fork: creation against a real controller/pool manager (env-gated)
- **Mocks** (`test/mocks/Mocks.sol`) — `MockController` + `MockPoolManager` + Phoenix error surface for the creator tests
- **JITMocks** (`test/mocks/JITMocks.sol`) — `MockERC20` (USDT-style option), `MockJITPoolManager`, `MockLimitOrderProtocol`, `OrderBuilder`
- **ERC1271Wallet** (`test/mocks/ERC1271Wallet.sol`) — minimal ERC-1271 contract wallet standing in for a Safe (contract-maker path)

### Scripts
- **Deploy** (`script/Deploy.s.sol`) — deploys factory, creator, adapter; prints the `grantRole(POOL_CREATOR_ROLE, creator)` call for the admin

### Example scripts (viem)
- **lib.mjs** (`docs/examples/lib.mjs`) — shared byte-plumbing (extension encoding, salt commitment, traits, signatures, known-errors ABI); imported by every other script here
- **plain-order.mjs** (`docs/examples/plain-order.mjs`) — post a vanilla order (no extension), SELL or BUY side
- **plain-fill.mjs** (`docs/examples/plain-fill.mjs`) — fill a plain order via `fillOrder`
- **jit-order.mjs** (`docs/examples/jit-order.mjs`) — underwriter posts a just-in-time SELL ask (adapter in the signed extension)
- **jit-fill.mjs** (`docs/examples/jit-fill.mjs`) — fill a JIT ask via `fillOrderArgs` with the exact extension bytes
- **lift-bid.mjs** (`docs/examples/lift-bid.mjs`) — underwriter lifts a bid as taker, minting delivery via `takerInteraction`
- **contract-order.mjs** (`docs/examples/contract-order.mjs`) — an ERC-1271 wallet posts an ask (PLAIN or JIT variant)
- **contract-fill.mjs** (`docs/examples/contract-fill.mjs`) — fill a contract-maker order via `fillContractOrderArgs` (raw signature bytes)
- **market-rfq.mjs** (`docs/examples/market-rfq.mjs`) — ceremony steps 1+2: `createMarket` (the request for quote) + opening bid
- **ceremony-e2e.mjs** (`docs/examples/ceremony-e2e.mjs`) — the whole ceremony end to end, both sides account-type parameterized

### Docs
- **integration.md** (`docs/integration.md`) — self-contained guide: `createMarket` parameters, precompute recipes, revert list, order layer
- **fork-testing.md** (`docs/fork-testing.md`) — running the fork suites; throwaway Phoenix stack recipe for a local anvil fork
- **examples README** (`docs/examples/README.md`) — the ceremony narrative, script ladder, approval matrix, common errors
- **walkthroughs** (`docs/examples/ceremony.md`, `plain-order.md`, `jit-order.md`, `contract-maker.md`) — prose companions to the scripts, one per order shape

### Skills
- **cork-operations** (`.claude/skills/cork-operations/SKILL.md`) — operating skill: mental model, decision table, safety rails; addresses and API reference live in its `references/`

### Edges
- CorkMarketCreator --imports--> FixedRateOracleFactory
- CorkMarketCreator --imports--> IDefaultCorkController
- CorkMarketCreator --imports--> IPoolManager
- CorkMarketCreator --calls--> FixedRateOracleFactory (`deploy(rate)`)
- CorkMarketCreator --calls--> DefaultCorkController (`createNewPool`)
- CorkMarketCreator --calls--> CorkPoolManager (`getId`, for the event)
- FixedRateOracleFactory --deploys--> FixedRateOracle
- FixedRateOracle --implements--> IRateOracle
- CorkLimitOrderAdapter --implements--> I1inchLimitOrderProtocol (`IPreInteraction` + `ITakerInteraction`)
- CorkLimitOrderAdapter --imports--> IPoolManager
- CorkLimitOrderAdapter --calls--> CorkPoolManager (`shares`, `previewMint`, `mint`, `market`)
- 1inch LOP v4 --calls--> CorkLimitOrderAdapter (the two hooks; sole authorized caller)
- Deploy --deploys--> FixedRateOracleFactory
- Deploy --deploys--> CorkMarketCreator
- Deploy --deploys--> CorkLimitOrderAdapter
- CorkMarketCreatorTest --tests--> CorkMarketCreator
- CorkLimitOrderAdapterJitTest --tests--> CorkLimitOrderAdapter
- FixedRateOracleTest --tests--> FixedRateOracle
- FixedRateOracleFactoryTest --tests--> FixedRateOracleFactory
- ERC1271WalletTest --tests--> ERC1271Wallet
- PhoenixIntegrationTest --tests--> CorkLimitOrderAdapter
- PhoenixIntegrationTest --tests--> CorkMarketCreator
- ContractMakerFillForkTest --tests--> CorkLimitOrderAdapter
- CorkMarketCreatorForkTest --tests--> CorkMarketCreator
- Mocks --mocks--> DefaultCorkController
- Mocks --mocks--> CorkPoolManager
- JITMocks --mocks--> CorkPoolManager
- JITMocks --mocks--> 1inch LOP v4
- contract-order.mjs --deploys--> ERC1271Wallet
- market-rfq.mjs --encodes-flow-of--> CorkMarketCreator
- ceremony-e2e.mjs --encodes-flow-of--> CorkMarketCreator
- ceremony-e2e.mjs --encodes-flow-of--> CorkLimitOrderAdapter
- plain-order.mjs --encodes-flow-of--> 1inch LOP v4
- plain-fill.mjs --encodes-flow-of--> 1inch LOP v4
- jit-order.mjs --encodes-flow-of--> CorkLimitOrderAdapter
- jit-fill.mjs --encodes-flow-of--> CorkLimitOrderAdapter
- lift-bid.mjs --encodes-flow-of--> CorkLimitOrderAdapter
- contract-order.mjs --encodes-flow-of--> 1inch LOP v4
- contract-fill.mjs --encodes-flow-of--> 1inch LOP v4
- integration.md --documents--> CorkMarketCreator
- integration.md --documents--> CorkLimitOrderAdapter
- fork-testing.md --documents--> CorkMarketCreatorForkTest
- fork-testing.md --documents--> ContractMakerFillForkTest
- examples README --documents--> walkthroughs
- walkthroughs --documents--> CorkLimitOrderAdapter
- cork-operations --documents--> CorkMarketCreator
- cork-operations --documents--> CorkPoolManager
- cork-operations --documents--> Phoenix API

## External integration facts

- 1inch Limit Order Protocol v4: `0x111111125421cA6dc452d289314280a0f8842A65` — canonical, same
  address on Ethereum mainnet and Arbitrum One (`src/interfaces/I1inchLimitOrderProtocol.sol`, `docs/examples/lib.mjs`).
- Chain: Arbitrum One, chain id 42161. Cork addresses are LIVE on the shadow Phoenix instance
  as of 2026-07-10, pinned in `.claude/skills/cork-operations/references/addresses.md` (the
  single address book; `POOL_CREATOR_ROLE` already granted). Note the address table in
  `docs/integration.md` still shows pre-deployment placeholders.
- Cork Phoenix API base: `https://api-phoenix.cork.tech`, everything under `/v1`: GET `/v1/pools/`,
  `/v1/pools/whitelisted-addresses`, `/v1/flows/`, `/v1/limit-orders/markets`,
  `/v1/limit-orders/orderbook`, `/v1/limit-orders/fills`; POST `/v1/limit-orders`. Filter with
  numeric `chainId=42161`. The live API cannot see a local anvil fork.
- `lib/phoenix` submodule pinned at `40d9b17`; the vendored interfaces were extracted at phoenix
  commit `0c22c5d3` (v1.1.2).

## Where to go deeper

| Topic | Read |
|---|---|
| Market-creation integration (parameters, precompute, reverts) | `docs/integration.md` |
| Fork testing setup (env gating, throwaway Phoenix stack) | `docs/fork-testing.md` |
| Ceremony walkthroughs and order shapes | `docs/examples/README.md` |
| Operating markets/pools/orders and the Phoenix API | `.claude/skills/cork-operations/` references |
