# Scratchpad — Rhinestone session + buy-cover

## Background and Motivation

After a successful `provision:account` (Safe + GUARD_MODULE + intent session via Rhinestone SDK), drive cover buys through Rhinestone. User does not want to run Cork CLI steps by hand — add a thin one-shot `buy-cover` orchestrator.

## Key Challenges and Analysis

- `cover.ts` only validates + sends pre-built artifacts; discovery/prepare stay in `ch`.
- Minimal approach: subprocess `ch query` / `ch prepare`, then subprocess `cover.ts send` (no LOP encoding rewrite).
- Cork Base deploy expected; chain from `CORK_CHAIN_ID`. `ch` must be on PATH (or `CH_BIN`).

## High-level Task Breakdown

1. Delete obsolete install/enable scripts; rebuild `session.ts` on Rhinestone. (done)
2. Add `buy-cover.ts` + `npm run buy:cover`. (done)
3. Manual e2e once Cork is live on Base + `ch` installed + CA on Safe.

## Project Status Board

- [x] Delete obsolete scripts + npm entries
- [x] Rebuild `session.ts` on Rhinestone
- [x] Wire `cover.ts` / `provision-account` / `rhinestone.ts`
- [x] Manual: `npm run cover -- status` on provisioned Safe (ENABLED)
- [x] Add `buy-cover.ts` + `buy:cover` npm script
- [ ] Manual e2e `buy:cover` when Cork Base + `ch` available
- [ ] Planner confirmation that buy-cover task is complete

## Current Status / Progress Tracking

Executor implemented [`zyfai/src/scripts/buy-cover.ts`](zyfai/src/scripts/buy-cover.ts):
`market-predict` → `orderbook` (first sufficient SELL) → `prepare taker-fill` → `cover send`.
Smoke: resolves Safe, fails clearly when `ch` missing.

## Executor's Feedback or Assistance Requests

Please confirm Planner sign-off. For a real buy, install cork-cli (`ch` / `CH_BIN`), fund Safe with CA, then:

```bash
npm run buy:cover -- --amount <cST_base_units> --expiry <unix> --recipe <recipe> [--dry-run]
```

## Lessons

- Rhinestone SDK v2 status uses `operations[].txHash`, not `fill.hash`.
- Import `@rhinestone/sdk/actions/smart-sessions` via ESM; CJS register can hit `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- Empty attester list on launchpad setup reverts; prefer SDK `sessions.enabled` path.
- `CallInput` is exported from `@rhinestone/sdk` — do not derive via optional `calls?[number]`.
