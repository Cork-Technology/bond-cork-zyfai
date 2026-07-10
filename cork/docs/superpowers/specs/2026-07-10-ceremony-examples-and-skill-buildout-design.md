# Ceremony Examples + cork-operations Skill Buildout — Design

Date: 2026-07-10
Status: Approved (brainstorming session with Zian)

## Context and goal

The repo has three artifacts that grew independently and are now out of sync:

1. **The contract.** `src/CorkLimitOrderAdapter.sol` is JIT-minting-only after the decay-pricing strip: it implements the 1inch Limit Order Protocol v4 `preInteraction` (maker-side just-in-time mint) and `takerInteraction` (taker-side just-in-time mint) hooks, nothing else.
2. **The examples.** `docs/examples/` documents "the ceremony" (market creation as the request-for-quote, then bid → discover → counter → fill) and ships three runnable order shapes: plain order + fill, JIT sell order + fill, and lift-bid (taker-side JIT). All three assume externally owned accounts. The ceremony doc describes a Safe (contract) maker, but no example covers contract makers.
3. **The skill design spec.** `docs/superpowers/specs/2026-07-10-cork-operations-skill-design.md` scopes limit orders to plain, unmodified 1inch v4 only. It never mentions the adapter, JIT minting, the ceremony, or the examples directory. The skill it describes (`.claude/skills/cork-operations/`) has not been built.

Goal: close all three gaps in **one pull request** — (A) add the missing examples, (B) rewrite the limit-order parts of the skill design spec around the ceremony with JIT as the primary path, (C) build the actual skill from the adjusted spec. The deliverable of the planning pipeline is an **implementation prompt** the user runs; the prompt executes tasks A → B → C sequentially, each by a dedicated agent.

## Decisions made during brainstorming

- **JIT is the primary path.** The skill teaches the ceremony (market as request-for-quote, JIT coverage orders via the adapter) as the main way to trade. Plain 1inch v4 orders are the fallback/simple case.
- **Either account type on either side.** Both maker and taker may be a Safe (contract account verified via ERC-1271) or an externally owned account. The `makerAccountType` rule — which signature scheme and which fill function — becomes a first-class decision point.
- **No on-chain cancel in the negotiation flow.** A counter-offer is a new order posted via the API with adjusted premium; either side picks which order to fill. Consequence the skill must state: a superseded order stays fillable until it expires, so every bid/ask in a negotiation sets an expiry in its maker traits.
- **Contract-maker examples use a minimal ERC-1271 wallet**, not real Safe tooling. The wallet is a small Solidity contract compiled by Foundry and deployed on the fork from its artifact. The walkthrough gets a short "what changes with a real Safe" note (Safe wraps messages in its own EIP-712 SafeMessage envelope before ERC-1271 verification).
- **Packaging:** one branch off `main`, one pull request, all three tasks. The prompt instructs one dedicated agent per task, run sequentially, with a checkpoint commit after each task.
- **Validation-first prompt generation** (per Zian's standing convention): before the implementation prompt is finalized, a throwaway worktree must prove the risky byte plumbing compiles and runs — see "Validation pass" below.

## Success criteria

1. Every new `.mjs` example runs to completion (exit code 0) against the anvil fork recipe in `docs/fork-testing.md`.
2. The contract-maker path is proven end to end on the fork: an order made by the minimal ERC-1271 wallet is filled via `fillContractOrderArgs`, including the variant with the JIT pre-interaction extension attached, and the `JITMinted` event fires.
3. `ceremony-e2e.mjs` drives the full flow (create market → opening bid → discovery → counter-ask → fill) on a bare fork with **no API configured** (file-based order handoff). With a Cork API URL configured, the same script posts and reads orders through the API instead.
4. `forge build` and the full existing Foundry test suite stay green, including the new wallet mock.
5. The adjusted design spec contains no plain-v4-only scope line; JIT/ceremony is the stated primary path; the sources-of-truth table cites `docs/examples/`.
6. The built skill exists at `.claude/skills/cork-operations/` with an always-loaded `SKILL.md` of roughly 150 lines and a total budget of roughly 1000 lines across all files.
7. Fresh-session test: an agent given only the built skill (no other repo context) can run the ceremony end to end on an anvil fork, and the EIP-712 order hash its snippets compute equals the on-chain `hashOrder()` result.

## Design

### Task A — missing examples (`docs/examples/`)

**A1. Contract-maker order + fill.**
- New mock: `test/mocks/ERC1271Wallet.sol` — minimal wallet: holds tokens, exposes `isValidSignature(bytes32, bytes) returns (bytes4)` (magic value `0x1626ba7e`) validating against a configured owner key, plus an `execute`-style call passthrough so the wallet can approve tokens. Covered by the Foundry suite (compile + a basic signature test).
- New walkthrough: `contract-maker.md` — how a contract maker signs (ERC-1271), why salt/extension mechanics are unchanged, why the counterparty must call `fillContractOrderArgs` instead of `fillOrderArgs`, and the "what changes with a real Safe" note.
- New scripts: `contract-order.mjs` (deploy wallet from artifact, fund it, build + sign order as the wallet, with plain and JIT variants selected by an environment variable, matching the existing examples' `SIDE=SELL/BUY` switch style) and `contract-fill.mjs` (fill via `fillContractOrderArgs`).

**A2. Market-as-request-for-quote + opening bid.**
- New script: `market-rfq.mjs` — call `createMarket` on `CorkMarketCreator` (which deploys the fixed-rate oracle via the factory), then post the opening JIT BUY bid on the fresh pool. Ceremony step 1 as one runnable script.

**A3. End-to-end ceremony script.**
- New script: `ceremony-e2e.mjs` — create market → opening bid → discovery → counter-ask (a **new** order with adjusted premium, no cancel) → fill of whichever order the counterparty accepts.
- Discovery is parameterized: if `CORK_API_URL` is set, orders go through POST/GET on the API; otherwise order payloads pass between steps through a local JSON file so the script runs on a bare fork.
- Account types are parameterized on both sides (externally owned account or the ERC-1271 wallet), exercising the account-type rule end to end.

**A4. Negotiation mechanics + expiry.**
- `lib.mjs` gains an expiry helper for the maker-traits bitfield (1inch v4 carries the expiration timestamp inside maker traits).
- `ceremony.md` gets a "Counter-offers" section: counter by posting a new order; either side picks what to fill; superseded orders stay fillable until expiry, so every negotiation order sets one.
- `docs/examples/README.md` updated to index all new files.

### Task B — adjust the skill design spec

Edits to `docs/superpowers/specs/2026-07-10-cork-operations-skill-design.md`:

- Limit-order scope becomes: "JIT coverage orders via `CorkLimitOrderAdapter` are the primary path; plain 1inch v4 orders are the fallback/simple case."
- The ceremony enters the skill's mental model: market creation *is* the request-for-quote; create → bid → discover → counter → fill is the core trading narrative.
- The account-type rule enters the decision table: `makerAccountType` decides signature verification (ECDSA recovery for externally owned accounts vs ERC-1271 `isValidSignature` for contracts) and fill function (`fillOrderArgs` vs `fillContractOrderArgs`).
- Sources-of-truth table adds `docs/examples/lib.mjs`, `docs/examples/ceremony.md`, and the order-shape scripts; the spec directs the skill's reference file to point at them rather than restate byte plumbing.
- Error-handling section adds the adapter revert catalog: `OnlyLimitOrderProtocol`, `OrderNotForPool`, `MintUnavailable`, `MintAmountDrift`.
- Negotiation rule added: counter-offers are new orders, no on-chain cancel, expiry mandatory on negotiation orders.
- Success criteria updated: the fresh-session end-to-end test becomes "run the ceremony on an anvil fork using only the skill," alongside the existing EIP-712-hash-matches-`hashOrder()` check.

### Task C — build the skill (`.claude/skills/cork-operations/`)

Built from the adjusted spec, keeping its structure:

- `SKILL.md` (~150 always-loaded lines): mental model including the ceremony, decision table including the account-type rule, safety rails, router to reference files.
- Five reference files: `addresses.md`, `market-creation.md`, `pool-actions.md`, `limit-orders.md`, `phoenix-api.md`.
- `limit-orders.md` is written JIT-first: ceremony flow, adapter extension recipe (pre-interaction slot = adapter address ++ encoded pool id; salt commits to the extension hash; maker-traits flags for HAS_EXTENSION and PRE_INTERACTION), account-type matrix, negotiation-by-new-order + expiry rule, then a short plain-order fallback section. Each section points to the corresponding `docs/examples/` script for exact bytes instead of duplicating them.
- Total stays within the spec's ~1000-line budget.

## Validation pass (before the implementation prompt is locked)

The riskiest untested assumption is the contract-maker path. In a throwaway worktree, prove on a fork that:

1. A minimal ERC-1271 wallet's signature passes the Limit Order Protocol's contract-order signature check.
2. `fillContractOrderArgs` completes against that order **with the JIT pre-interaction extension attached**, and the adapter mints (i.e. the extension/salt mechanics from `lib.mjs` compose with the contract-order fill path).

Findings (exact call shapes, any gotchas in argument encoding) feed the implementation prompt; the worktree is then discarded. If validation falsifies an assumption, the design's A1/A3 shapes are corrected before the prompt is written — the prompt never encodes unproven plumbing.

## Error handling

- Every new script fails loudly with the decoded protocol/adapter revert, matching the style of the existing examples.
- `ceremony-e2e.mjs` distinguishes "API configured but unreachable" (hard error with a clear message) from "API not configured" (expected file-handoff mode).

## Testing

- New `.mjs` scripts: run green against the `docs/fork-testing.md` anvil recipe (success criteria 1–3).
- Foundry: `forge build` clean; existing suite green; `ERC1271Wallet` mock gets at least a compile-and-verify-signature test.
- Skill: fresh-session ceremony run per success criterion 7.

## Packaging and execution model

- One branch off `main`, one pull request containing all three tasks.
- The planning pipeline's deliverable is an implementation prompt at `docs/superpowers/prompts/` that runs tasks A → B → C **sequentially**, each handled by a **dedicated agent**, with a checkpoint commit after each task.
- Order matters: A's examples become the source of truth B points at; B's adjusted spec is the blueprint C builds from.

## Rejected alternatives

- **Keep the spec's plain-v4-only scope and bolt the adapter on as an appendix.** Rejected: JIT is the demo's actual flow; an agent taught plain-orders-first would default to the wrong path.
- **Real Safe tooling for the contract-maker examples.** Rejected for now: Safe's message-wrapping adds tooling weight without changing the protocol-side shape being demonstrated; a minimal ERC-1271 wallet proves the same fill path. Documented as a note instead.
- **On-chain `cancelOrder` example.** Rejected: the negotiation model supersedes orders by posting new ones; expiry bounds the risk of stale orders.

## Known limitations

- The minimal ERC-1271 wallet is not a Safe; real-Safe signing (SafeMessage envelope) is documented but not runnable in this pull request.
- The live Cork API path of `ceremony-e2e.mjs` can only be smoke-tested when the API is reachable from the dev environment; the file-handoff mode is the criterion that gates the pull request.
