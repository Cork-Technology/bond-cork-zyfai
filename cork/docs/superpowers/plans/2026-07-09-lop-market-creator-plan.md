# Implementation Plan: Permissionless Market Creation Wrapper + Fixed-Rate Oracle Factory

- **Date:** 2026-07-09 (rewritten same day for the scope cut: 1inch Limit Order Protocol integration dropped; original plan at git commit `e7c466a`)
- **Spec (source of truth):** `docs/superpowers/specs/2026-07-09-lop-market-creator-design.md`
- **Prompt:** `docs/superpowers/prompts/2026-07-09-lop-market-creator-prompt.md`
- **Execution model:** one prompt, one agent. The main session spins up a single agent with the prompt file, verbatim.

## Phase 0 — Validation worktree (DONE, 2026-07-09, carries over)

Ran per the global convention before the prompts were frozen, against the original superset design. Results (full detail in spec §8.1, §9, §10):

1. **Compile proof:** a throwaway Foundry project with the vendored interfaces and skeleton contracts compiles cleanly (28 files, solc 0.8.30) and passes 5/5 tests: CreateParams encode/decode round-trip, CREATE2 `computeAddress` parity (including a 256-run fuzz over the rate), zero-rate revert by selector, end-to-end create flow against mocks with a second-create no-op.
2. **Existence check resolved:** `poolManager.market(id)` returns an all-zero struct for unknown markets (natspec wrongly claims it reverts). Check both asset fields nonzero. No try/catch.
3. **Rate-band recipe corrected:** phoenix requires `rateMin > 0` and strictly `rateMin < rateMax` — the confirmed fixed-rate recipe is `rateMin = rate`, `rateMax = rate + 1`, `rateChangePerDayMax = 0`, `rateChangeCapacityMax = 0`; the adjusted rate then equals the oracle rate for the market's whole life.
4. **Oracle lifecycle safety confirmed:** `rate()` is the only method ever called on a market's stored oracle (single funnel: `ConstraintRateAdapter._fetchRate`). A plain `IRateOracle` implementation cannot brick a market mid-life.
5. **Fee scale confirmed:** 1e18 = 1%, max `5e18` (5%) enforced at creation. `PoolCreationParams` field order puts the **unwind fee before the swap fee** — named-field construction is mandatory.
6. **Decimals bound confirmed:** at most 18, no lower bound.

The scope cut removes assumptions (all 1inch mechanism facts) and adds none, so this validation carries over; no new worktree pass is required (spec §9).

## Phase 1 — The prompt (single agent)

Scaffold the Foundry project (the repo currently contains only `docs/`), vendor the three Cork interfaces, implement `FixedRateOracle`, `FixedRateOracleFactory`, and `CorkMarketCreator` (single `createMarket` entry point, existence-check no-op, expiry require on the create branch only), unit tests with mocks, the Arbitrum fork test, the deploy script, and the agent-integration doc for Bond (from spec §4).

**Fork-test dependency (spec §8.3):** the fork test needs shadow-deployment addresses (controller, pool manager, admin). Contingency ladder, trigger Thursday end of day 2026-07-09:
1. Addresses confirmed → fork against the shadow deployment, `vm.prank` the admin for the role grant.
2. Not confirmed → clone `phoenix-private` **outside** the repo, deploy a throwaway Phoenix stack on a local Arbitrum fork, run the same test.
3. Neither ready → descope the fork test to post-hackathon; the mocked unit suite becomes the gating demonstration; spec criteria 3–4 move to open items.

**Gate to done:** spec §7.1 criteria 1, 2, 5, 6 unconditionally; 3, 4, 7 under contingency rung 1 or 2. Committed (no session trailers in commit messages).

## Phase 2 — Deployment + wiring (ops, outside the prompt)

- Run the deploy script on Arbitrum (shadow deployment): deploy factory → deploy creator → admin grants `POOL_CREATOR_ROLE` on `DefaultCorkController` to the creator.
- Record deployed addresses in the integration doc; hand the doc + fork test to Bond.

## Risks

| Risk | Mitigation |
|---|---|
| Shadow deployment not live in time | §8.3 contingency ladder above; Slack draft to Baptiste awaiting user approval |
| Fee/whitelist front-run (first-writer-wins, outside MarketId) | Documented in spec §3.5/§4 step 3; front-run fork-test case; optional revert-on-mismatch recorded in §8.4 as a decision not taken |
| Positional `PoolCreationParams` construction swaps the two fees | Named-field construction mandated in both the prompt and the vendored interface comment |
| `market()` natspec contradicts implementation in a future phoenix version | Existence check asserted by behavior in tests (existing market always no-ops, never reverts) |
| Duplicate creation with `isWhitelistEnabled = true` reverts in the WhitelistManager before the pool manager | Irrelevant on the happy path (creator's existence check runs first) — noted so nobody "optimizes" the check away |
