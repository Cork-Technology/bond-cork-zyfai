# Design: `cork-operations` skill

- **Date:** 2026-07-10
- **Status:** Approved (design); pending spec review
- **Deliverable:** a Claude Code skill at `.claude/skills/cork-operations/` in this repo

## Context and goal

Build a concise skill that teaches an autonomous, transaction-executing AI agent everything technical it needs to operate Cork Phoenix on the Arbitrum shadow stack: create markets, run the full pool lifecycle (deposit, mint, unwind, exercise, swap, redeem, withdraw), run the trading ceremony — market creation as the request for quote, then bid → discover → counter → fill — with just-in-time (JIT) coverage orders via `CorkLimitOrderAdapter` as the primary path and plain 1inch v4 orders as the fallback, and read the Cork Phoenix API. The consumer is an agent that signs and sends transactions itself, so the skill must contain exact, executable recipes plus decision rules — not just concepts.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Audience | Autonomous agent that executes (signs and sends transactions, posts orders) |
| Deployment target | Arbitrum shadow stack; contract addresses are placeholders until deployment lands |
| Tooling idiom | TypeScript + viem for all recipes (transactions and typed-data signing) |
| "When to do X" depth | Mechanics + rationale: preconditions, economic meaning, situations where each action makes sense. No quantitative trading strategy. |
| Location | `.claude/skills/cork-operations/` in cork-lop-market-creator-hackathon |
| Limit-order scope | JIT coverage orders via `CorkLimitOrderAdapter` (pre-/taker-interaction hooks on 1inch Limit Order Protocol v4) are the primary path; plain 1inch v4 orders are the fallback/simple case |
| Trading narrative | The ceremony: market creation IS the request for quote; create → bid → discover → counter → fill is the core flow the skill teaches |
| Account types | Either side may be an externally owned account or a contract account (Safe / ERC-1271); `makerAccountType` is a first-class decision point — it decides both signature verification and fill function |
| Negotiation | Counter-offers are new orders posted via the API; no on-chain cancel; expiry mandatory on every negotiation order |

## Success criteria

1. A fresh agent session given only this skill, an RPC endpoint, and funded keys runs the ceremony end to end — create market (the request for quote) → opening bid → discovery → counter-ask → fill — on an anvil fork running the throwaway Phoenix stack from `docs/fork-testing.md`, without opening any source repo. `docs/examples/ceremony-e2e.mjs` is the reference implementation of this flow.
2. Every pool-action and market-creation snippet, run against that fork, executes or reverts exactly as its recipe states.
3. A limit order built per the skill produces an EIP-712 (typed structured data) hash equal to the on-chain `hashOrder()` result, and a `POST /v1/limit-orders` payload that validates against the Phoenix API OpenAPI spec.
4. Context stays small: the always-loaded file is ~150 lines; no task requires loading more than one reference file.

## Design

One short always-loaded router file plus five focused reference files (progressive disclosure). The agent always reads `SKILL.md` (mental model, decision table, safety rails), then loads exactly one reference file per task. "Concise" here means a small amount of text per task, not a short document overall.

```
.claude/skills/cork-operations/
  SKILL.md                      ~150 lines — mental model, decision table, safety rails, router
  references/
    addresses.md                ~40 lines  — the single address book
    market-creation.md          ~200 lines — create markets via CorkMarketCreator
    pool-actions.md             ~250 lines — every CorkPoolManager user action
    limit-orders.md             ~250 lines — the ceremony + JIT coverage orders (primary), plain 1inch v4 fallback
    phoenix-api.md              ~150 lines — API catalog + conventions
```

Total budget ≈ 1,000 lines. Every recipe is self-contained TypeScript + viem with inline `parseAbi` fragments — no external ABI files, no build step.

### SKILL.md (always loaded)

1. **Mental model (~15 lines).** A Cork pool pairs a Collateral Asset with a Reference Asset at a fixed expiry. Depositing collateral mints two tokens 1:1: cPT (Cork Principal Token, the principal claim) and cST (Cork Swap Token, the hedge). Pre-expiry, cST + reference asset converts to collateral at an oracle rate clamped by a rate limiter (the ConstraintRateAdapter credit bucket). Post-expiry, cPT redeems the pro-rata remainder; cST becomes worthless. Rate semantics: 1e18-scaled "value of 1 reference asset in collateral asset". Fees: 1e18 = 1%, capped at 5%. Trading happens through the ceremony: creating a market IS the request for quote (a costly, credible on-chain ask), and create → bid → discover → counter → fill is the core narrative. JIT minting via `CorkLimitOrderAdapter` means nobody deposits anything until a trade actually happens — the opening bid is deliberately plain-shaped (no extension); taker-side JIT is the lifter's unsigned choice at fill time.

2. **Decision table** — one row per action:

| You hold / want | Phase | Action |
|---|---|---|
| Collateral; want both tokens (sell one side, provide liquidity) | pre-expiry | `deposit` / `mint` |
| Equal cPT + cST; want collateral back | pre-expiry | `unwindDeposit` / `unwindMint` |
| cST + reference asset; conversion attractive (hedge payout) | pre-expiry | `exercise` / `swap` |
| Collateral; want to buy back locked cST + reference from pool | pre-expiry | `unwindExercise` / `unwindSwap` |
| cPT; market expired | post-expiry only | `redeem` / `withdraw` |
| Buy/sell cPT or cST at your own price instead of pool rate | pre-expiry | JIT coverage order via `CorkLimitOrderAdapter` (primary); plain 1inch v4 order when you already hold what you sell (fallback) |
| No market for your pair/expiry/rate | — | create one (permissionless on shadow stack) — creation IS the request for quote; follow with an opening bid |

Plus the account-type rule (`makerAccountType` decides both columns; takers read it off the book and branch — the wrong variant reverts `BadSignature`):

| Maker | Signature verification | Fill function |
|---|---|---|
| Externally owned account (`EOA`) | ECDSA recovery: signer == maker | `fillOrderArgs` (EIP-2098 compact `r`/`vs`) |
| Contract account (`CONTRACT`, Safe / ERC-1271) | `isValidSignature(orderHash, sig)` returns the magic value `0x1626ba7e` | `fillContractOrderArgs` (raw signature bytes) |

3. **Safety rails (hard rules).**
   - Always `simulateContract` before `writeContract`.
   - Always call the matching `preview*`/`max*` view first and bound inputs by it.
   - Direct pool-manager calls have no slippage or deadline protection — re-check `swapRate` at send time.
   - Check the pause bitmap, whitelist flag, and expiry phase before any action.
   - Size approvals exactly (limit orders: sum of remaining open-order amounts + new order amount).
   - Counter-offers are NEW orders, never on-chain cancels; a superseded order stays fillable until it expires, so every bid/ask in a negotiation MUST set an expiry in its maker traits (`orderExpiry()` in `docs/examples/lib.mjs`; the protocol reverts `OrderExpired` past it).
   - Always use named struct fields — `PoolCreationParams` puts the unwind fee before the swap fee; positional arguments are a known footgun.
   - Shares are always 18 decimals; assets use native decimals (max 18).

4. **Router.** One line per reference file stating when to load it.

### references/addresses.md

The only place addresses live; all other files say "see addresses.md". Placeholders for `CorkMarketCreator`, `FixedRateOracleFactory`, `DefaultCorkController`, `CorkPoolManager`, `ConstraintRateAdapter`, `WhitelistManager` on Arbitrum One. Real values for the 1inch Limit Order Protocol (`0x111111125421ca6dc452d289314280a0f8842a65` on Arbitrum One) and the API base URL (`https://api-phoenix.cork.tech`). One fill-in pass after deployment updates the whole skill.

### references/market-creation.md

- Parameter recipe (source: `docs/integration.md`): `rateMin = rate`, `rateMax = rate + 1`, rate-change fields 0, fee scale 1e18 = 1% with 5e18 cap, whitelist flag semantics, first-writer-wins on fees/whitelist for a given market identity.
- Precompute before sending: oracle address via CREATE2 `computeAddress(rate)`; marketId as keccak256 of the ABI-encoded Market struct (field order is load-bearing).
- One-shot factory behavior: deploying a repeat rate reverts with no error data — check `computeAddress(rate)` for existing code first.
- Full revert catalog.
- Recipe: simulate → `createMarket(CreateParams)` → parse the `MarketCreated` event.

### references/pool-actions.md

One block per action — `deposit`, `mint`, `unwindDeposit`, `unwindMint`, `exercise`, `exerciseOther`, `swap`, `unwindExercise`, `unwindExerciseOther`, `unwindSwap`, `redeem`, `withdraw`, `withdrawOther` — each with:

- function signature;
- preconditions: phase, balances, approvals (e.g. exercise needs cST **and** reference-asset approval; redeem/withdraw burn cPT via allowance when acting for another owner);
- one-sentence economic meaning;
- the preview/max companion to call first;
- rounding direction (deposit floors, mint ceils);
- revert list;
- viem snippet.

Plus: reading market state (`market()`, `assets()`, `swapRate()`, `shares()`, `getPausedBitMap()` with bits spelled out: bit 0 deposit, 1 swap, 2 withdrawal, 3 unwind-deposit, 4 unwind-swap) and expiry rules (`>=` counts as expired; first post-expiry redemption archives pool balances; `maxUnwindExercise`/`maxUnwindSwap` ignore the caller's balance).

### references/limit-orders.md (JIT-first)

Written ceremony-first; every section points at the matching `docs/examples/` script for exact bytes instead of restating byte plumbing (the plumbing lives in `docs/examples/lib.mjs` and is already fork-proven).

- **The ceremony**: market creation IS the request for quote; create → bid → discover → counter → fill. The opening bid is deliberately plain-shaped (no extension) — taker-side JIT is the lifter's unsigned choice, attached as `args` at fill time; maker-side JIT (an ask that mints its cST delivery at fill) commits the adapter in the signed extension. Scripts: `market-rfq.mjs` (create + opening bid), `ceremony-e2e.mjs` (the whole loop, both discovery modes, both account types).
- **Adapter extension recipe (primary path)**: pre-interaction slot = adapter address ++ `abi.encode(poolId)`; salt's low 160 bits commit to `keccak256(extension)`; maker-traits flags HAS_EXTENSION (bit 249) and PRE_INTERACTION (bit 252). Scripts: `jit-order.mjs` / `jit-fill.mjs` / `lift-bid.mjs`; helpers `buildExtension`, `saltForExtension`, `packTargetAndData` in `lib.mjs`.
- **Account-type matrix** (the `makerAccountType` rule from SKILL.md, spelled out): `EOA` → ECDSA recovery + `fillOrderArgs` with the EIP-2098 compact split; `CONTRACT` → ERC-1271 `isValidSignature` + `fillContractOrderArgs` with the raw 65-byte `r ++ s ++ v` signature. A contract maker's owner signs the raw EIP-712 order hash; a real Safe differs — it wraps the hash in its own SafeMessage envelope first (see `docs/examples/contract-maker.md`). Scripts: `contract-order.mjs` (`VARIANT=PLAIN|JIT`) / `contract-fill.mjs`.
- **Negotiation**: a counter-offer is a NEW order posted via the API at the adjusted premium; nothing is cancelled on-chain; either side picks which order to fill. Superseded orders stay fillable until expiry, so expiry is mandatory on every negotiation order (`orderExpiry()` / `expiryOf()` in `lib.mjs` — bits 80–119 of maker traits; `OrderExpired` on-chain past it). `cancelOrder` exists for emergencies only, costs gas, and is not part of the flow.
- The 8-field 1inch v4 order struct; Cork's bit conventions: the partial-fill bit must equal the multiple-fill bit (API rejects otherwise), nonce placement; never Permit2 for makers — classic `approve` only.
- Signing: EIP-712 via viem `signTypedData`; domain name "1inch Limit Order Protocol", version "4", chainId, verifying contract per addresses.md; cross-check the computed hash against on-chain `hashOrder()`.
- Submission: full `POST /v1/limit-orders` payload including Cork metadata (side BUY/SELL, premium in basis points 0–10000, maker account type EOA/CONTRACT, nonce, expiry, allowsPartialFills).
- Management: approval sizing rule; max 5 active orders per maker per pool.
- Trust rule: the orderbook is discovery only — verify invalidator state, maker balance, and allowance on-chain before relying on any order.
- **Plain-order fallback (short closing section)**: no extension, no adapter — the simple case when the maker already holds the asset it sells. Scripts: `plain-order.mjs` / `plain-fill.mjs`.
- Environment-variable conventions the skill must name correctly: `ceremony-e2e.mjs` uses `CORK_API_URL` (older scripts use `ORDERBOOK_URL`); file-mode handoffs are `ORDER_FILE` (contract-order/market-rfq) and `STATE_FILE` (ceremony-e2e); account types are `ASKER_ACCOUNT`/`UNDERWRITER_ACCOUNT` = `EOA|CONTRACT`.
- One line: a later phase ("CGB": Cork-owned settlement, premium-APY pricing, maker hooks, N-order fills) exists but is not live; this file covers the live adapter path.

### references/phoenix-api.md

- Compressed catalog of the read surfaces: `GET /v1/pools/`, `GET /v1/pools/whitelisted-addresses`, `GET /v1/flows/`, `GET /v1/limit-orders/markets`, `GET /v1/limit-orders/orderbook`, `GET /v1/limit-orders/fills` — key filters and response shapes for each.
- Conventions: no authentication; cursor pagination (`{items, nextCursor, hasMore}`); limit max 2000; wei values as strings.
- Fee-name mapping stated once: on-chain `swapFee`/`unwindSwapFee` ↔ API `exerciseFeePercentage`/`repurchaseFeePercentage`.
- Arbitrum caveat: the chain enum is `mainnet | virtual | sepolia` today, so on Arbitrum fall back to direct viem reads — pool state via `CorkPoolManager` views, positions via token `balanceOf`.

## Error handling

Each recipe carries its own revert list (sourced from `docs/integration.md` and `IPoolManager.sol` natspec) with the plain-English cause and fix beside each error name. Simulate-before-send is mandatory everywhere, so the agent sees named errors before spending gas.

The limit-orders file additionally carries the `CorkLimitOrderAdapter` revert catalog (all four are in `KNOWN_ERRORS_ABI` in `docs/examples/lib.mjs`, decoded by its `failWith` helper):

| Adapter revert | Cause |
|---|---|
| `OnlyLimitOrderProtocol` | the interaction callback was called by something other than the 1inch Limit Order Protocol |
| `OrderNotForPool` | neither order side is the pool's cST — the extension's pool id does not match the order |
| `MintUnavailable` | the pool cannot mint: `previewMint` returned 0 (market whitelisted, paused, or expired — create markets with the whitelist OFF) |
| `MintAmountDrift` | `mint` spent a different collateral amount than `previewMint` quoted in the same transaction (guards the exact-allowance and no-custody invariants; should be unreachable) |

## Testing

- **Fork smoke test:** run every market-creation and pool-action snippet against the throwaway Phoenix stack from `docs/fork-testing.md` (anvil fork of Arbitrum). Pass = each snippet executes or reverts exactly as its recipe states.
- **Limit orders:** validate the built order's EIP-712 hash against on-chain `hashOrder()`; validate the POST payload against the saved OpenAPI spec. A live POST requires the API to index the target chain — an acknowledged gap for Arbitrum today; the file-handoff mode of `docs/examples/ceremony-e2e.mjs` covers the flow on a bare fork until then.
- **Acceptance test:** success criterion 1 above — a fresh agent session runs the ceremony end to end on an anvil fork using only the skill, and the EIP-712 order hash its snippets compute equals the on-chain `hashOrder()` result.

## Sources of truth (kept as a comment block in each skill file)

| Skill file | Source |
|---|---|
| market-creation.md | `docs/integration.md` + `src/` in this repo |
| pool-actions.md | `phoenix-private/contracts/interfaces/IPoolManager.sol` natspec + phoenix README |
| limit-orders.md | `docs/examples/` — `ceremony.md` (the flow + the account-type rule) and `contract-maker.md` (contract makers, real-Safe note); `lib.mjs` (extension encoding, salt commitment, maker/taker traits incl. `orderExpiry`/`expiryOf`, EIP-712 + compact signatures, `KNOWN_ERRORS_ABI`); the order-shape scripts `plain-order.mjs`/`plain-fill.mjs`, `jit-order.mjs`/`jit-fill.mjs`/`lift-bid.mjs`, `contract-order.mjs`/`contract-fill.mjs`, `market-rfq.mjs`, `ceremony-e2e.mjs`; plus `src/CorkLimitOrderAdapter.sol` for the hook semantics |
| phoenix-api.md | live OpenAPI spec at `https://api-phoenix.cork.tech/docs/json` |

The examples are fork-proven against the real 1inch Limit Order Protocol v4 AND the real Phoenix `CorkPoolManager` (the JIT mint has been exercised on a fork by the `contract-order.mjs`/`ceremony-e2e.mjs` runs and `test/fork/ContractMakerFill.fork.t.sol` — not just against mocks). The skill's limit-orders reference file points at these files for exact bytes; it never restates the byte plumbing.

## Known limitations and open questions

- Shadow-stack contract addresses are placeholders until the Arbitrum deployment lands; `addresses.md` is the single fill-in point.
- The Phoenix API does not index Arbitrum yet; API-dependent flows (orderbook discovery, order submission) cannot be exercised end-to-end on the shadow stack until it does. The skill states the viem fallback for reads, and the ceremony runs on a bare fork via `ceremony-e2e.mjs`'s file-handoff mode (`STATE_FILE`) in the meantime.
- Fee vocabulary differs between phoenix contracts and the API; the skill states the mapping once in phoenix-api.md rather than silently picking one.

## Rejected alternatives

- **Single monolithic SKILL.md:** forces every task to carry all content (limit-order signing details in a market-creation task and vice versa); blows the per-task context budget and degrades as content grows.
- **Shipping a TypeScript helper library inside the skill:** adds a build/maintenance burden and can silently drift from what the agent actually runs; copy-pasteable markdown snippets cannot.
