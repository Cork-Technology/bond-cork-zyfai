# Implementation Prompt — Ceremony Examples + cork-operations Skill Buildout

Copy everything below into a fresh Claude Code session at the repo root.

---

Implement the approved design spec at `docs/superpowers/specs/2026-07-10-ceremony-examples-and-skill-buildout-design.md`. Read that file FIRST and treat it as the source of truth; this prompt is the execution recipe, not a replacement for it.

## Ground rules

- Create one branch off `main` named `feat/ceremony-examples-and-skill`. All work lands there; one pull request at the end containing everything.
- Run the three tasks below SEQUENTIALLY. Each task is executed by its OWN dedicated agent (one Agent dispatch per task; do not bundle tasks into one agent; do not parallelize them — B points at A's output, C builds from B's output).
- Make a checkpoint commit after each task completes and its checks pass.
- Never add a `Claude-Session:` trailer or any `claude.ai/code` link to commit messages or the pull request body.
- Solidity rules: run `forge build` after every contract change; in tests, always pass a proper error selector to `vm.expectRevert()` — never call it bare.
- Key repo facts the agents will need: the adapter is `src/CorkLimitOrderAdapter.sol` (JIT-mint-only: `preInteraction` + `takerInteraction`, both decode `extraData` as `abi.encode(MarketId)`); the real 1inch Limit Order Protocol v4 is at `0x111111125421cA6dc452d289314280a0f8842A65`; byte plumbing (extension offsets header, salt low-160-bits committing to `keccak256(extension)`, makerTraits bit 249 = HAS_EXTENSION and bit 252 = PRE_INTERACTION, EIP-712 + EIP-2098 compact signatures) lives in `docs/examples/lib.mjs` and is already proven for the externally-owned-account path by `docs/examples/jit-order.mjs` / `jit-fill.mjs`.

## Task A — missing examples (dedicated agent)

Scope: spec sections A1–A4. Deliverables:

1. **Prove the contract-maker path first (this validation gates the rest of the task).** Write `test/fork/ContractMakerFill.fork.t.sol`, a Foundry fork test in the style of `test/fork/CorkMarketCreator.fork.t.sol`, against the REAL Limit Order Protocol v4 on the fork:
   - Add `test/mocks/ERC1271Wallet.sol`: a minimal wallet holding tokens, with `isValidSignature(bytes32, bytes) returns (bytes4)` returning the magic value `0x1626ba7e` when the hash was signed by its configured owner key, plus a call-passthrough so the wallet can issue ERC-20 approvals.
   - Prove (a) a PLAIN order made by the wallet fills via `fillContractOrderArgs`, and (b) the JIT variant — same order with the pre-interaction extension (`adapter ++ abi.encode(poolId)`) — fills with the adapter minting for the wallet and the `JITMinted` event firing.
   - If either assumption is falsified, STOP the task, record exactly what differs (signature bytes layout, approvals, taker traits), adjust the plan for steps 2–5 accordingly, and note the deviation in the checkpoint commit message.
2. `docs/examples/contract-maker.md` + `contract-order.mjs` + `contract-fill.mjs` per spec A1 (plain/JIT variants selected by an environment variable, matching the existing `SIDE=SELL/BUY` switch style; include the "what changes with a real Safe" note — Safe wraps messages in its own SafeMessage EIP-712 envelope before ERC-1271 verification).
3. `docs/examples/market-rfq.mjs` per spec A2 (createMarket via `CorkMarketCreator`, then post the opening JIT BUY bid).
4. `docs/examples/ceremony-e2e.mjs` per spec A3 (full flow; discovery via `CORK_API_URL` when set, local JSON file handoff otherwise; account type parameterized on both sides; distinguish "API configured but unreachable" = hard error from "API not configured" = file mode).
5. Spec A4: expiry helper in `lib.mjs` (expiration timestamp inside the maker-traits bitfield), "Counter-offers" section in `ceremony.md` (counter = new order via API, either side picks what to fill, superseded orders stay fillable until expiry so every negotiation order sets one), and update `docs/examples/README.md` to index everything new.

Checks before the checkpoint commit: `forge build` clean; full `forge test` suite green including the new fork test; every new `.mjs` runs to exit code 0 against the anvil fork recipe in `docs/fork-testing.md`; all new scripts fail loudly with decoded protocol/adapter reverts, matching the existing examples' style.

Checkpoint commit: `feat: contract-maker, market-rfq and ceremony e2e examples + ERC-1271 fork proof`

## Task B — adjust the skill design spec (dedicated agent)

Edit `docs/superpowers/specs/2026-07-10-cork-operations-skill-design.md` per the design spec's Task B section, exactly:

- Replace the "V1 only / unmodified 1inch v4" limit-order scope with: JIT coverage orders via `CorkLimitOrderAdapter` are the primary path; plain 1inch v4 orders are the fallback/simple case.
- Wire the ceremony into the mental model: market creation IS the request-for-quote; create → bid → discover → counter → fill is the core trading narrative.
- Add the account-type rule to the decision table: `makerAccountType` decides signature verification (ECDSA recovery vs ERC-1271 `isValidSignature`) and fill function (`fillOrderArgs` vs `fillContractOrderArgs`).
- Add `docs/examples/lib.mjs`, `docs/examples/ceremony.md`, and the order-shape scripts (including Task A's new ones) to the sources-of-truth table; direct the skill's reference file to point at them instead of restating byte plumbing.
- Add the adapter revert catalog to error handling: `OnlyLimitOrderProtocol`, `OrderNotForPool`, `MintUnavailable`, `MintAmountDrift`.
- Add the negotiation rule: counter-offers are new orders, no on-chain cancel, expiry mandatory on negotiation orders.
- Update success criteria: fresh-session end-to-end test = run the ceremony on an anvil fork using only the skill; keep the EIP-712-hash-equals-`hashOrder()` check.

Consistency check before commit: no remaining reference to decay pricing or to a plain-v4-only scope anywhere in the edited spec; every file the spec names actually exists after Task A.

Checkpoint commit: `docs: rewire cork-operations skill spec around JIT-primary ceremony`

## Task C — build the skill (dedicated agent)

Build `.claude/skills/cork-operations/` from the ADJUSTED spec (read it fresh after Task B):

- `SKILL.md` (~150 always-loaded lines): mental model including the ceremony, decision table including the account-type rule, safety rails, router.
- Five reference files: `addresses.md`, `market-creation.md`, `pool-actions.md`, `limit-orders.md`, `phoenix-api.md`.
- `limit-orders.md` JIT-first: ceremony flow, adapter extension recipe, account-type matrix, negotiation-by-new-order + expiry rule, then a short plain-order fallback — each section pointing at the matching `docs/examples/` script for exact bytes, never duplicating them.
- Keep the total across all skill files within ~1000 lines.

Verification: fresh-session test per the design spec's success criterion 7 — an agent given ONLY the built skill runs the ceremony end to end on an anvil fork, and the EIP-712 order hash its snippets compute equals the on-chain `hashOrder()` result. Fix the skill until this passes.

Checkpoint commit: `feat: cork-operations skill — JIT-primary ceremony, market ops, phoenix API`

## Finish

- Re-run `forge build` + full `forge test`; re-run each new `.mjs` once more on a fresh fork.
- Open one pull request to `main` titled `feat: ceremony examples + cork-operations skill`, whose body maps each task to its checkpoint commit and states the design spec's 7 success criteria with pass/fail. No session links in the body.
