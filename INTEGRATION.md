# Integrating Cork cover — the runbook

> **Audience:** Zyfai engineering, and the agents working on their behalf.
> **Assumes:** Safe / ERC-7579 smart accounts, 1inch Limit Order Protocol v4,
> EIP-712 / ERC-1271 signing, ERC-2612 permits, ERC-4626 vaults.
> **Chain:** Base (8453) first; everything transfers to Arbitrum One (42161) by
> changing the chain id and asset addresses.
> **Pin:** Distribution [`phoenix/v0.4-rc.1`](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.4-rc.1.json).
> **Status:** updated 2026-09-24 against that pin (first written 2026-08-11
> against `v0.1-rc.1`, re-pinned 2026-08-14 to `v0.2-rc.1` and 2026-09-01 to
> `v0.3-rc.1`; what moved between the pins is in the README's "Moving from
> v0.3-rc.1"). If the pin has moved again, this document is orientation, not
> instruction — re-read the manifest first.

This document sequences the integration. It does not duplicate the reference
material: each step links the pinned document that carries the detail. The full
teaching walkthrough — Cork's model, the glossary, every command in runnable
form — is the
[Zyfai quickstart](https://github.com/Cork-Technology/cork-cli/blob/v0.6.0/docs/zyfai-quickstart.md);
this runbook is the spine that tells you what to do, in what order, and who owns
what. One drift caveat, straight from the manifest: the tag-pinned quickstart is
**orientation, not `v0.6.0` integration evidence** — most of its captured
outputs date from `v0.2.0-rc.2` on the previous generation. Its generation
notes and its exercise step (§3 step 4) were re-captured live in September
2026. The standing rule absorbs the rest: pull authoritative values from
`ch query`, never from prose.

## What you are integrating, in one paragraph

Cork lets your agent hold a high-yield USDC position its risk gate would
otherwise exclude, by buying **cST** — per-market cover that swaps the covered
(reference) asset for the collateral asset at the market's tracked rate, any
time before the market's expiry. Your agent requests quotes off-chain (RFQ,
request-for-quote), the underwriter answers with priced options and rests a
signed 1inch limit order, and your fill of that order settles everything
atomically on-chain — the market itself is created just-in-time by the fill if
it doesn't exist yet. If the underlying impairs, your agent exercises the cST
on-chain — a direct call that needs no counterparty, so it works exactly when
the market is stressed. Full model and glossary: quickstart §1–§2.

## Two generations, one adapter each

Since this pin a chain hosts **two active contract generations**:
`phoenix/v0.4-rc.1`, the primary, and `phoenix/v0.3-rc.1`, the previous one.
Nothing is retired. Every pool the venue lists today lives on the previous
generation; new markets are created on the primary.

The pinned tool handles both. A read or prepare **by pool id follows the pool's
own generation**, resolved from the chain. A prepare that is not pool-scoped
targets the primary unless you pass `generation` — a label, or the alias
`previous`. Every result names the generation it answered from in
`data.generation`. `ch query protocol-config` lists every generation with each
block's addresses; `cork_capabilities topic:"generations"` is the contract.

A **ForSelf adapter serves exactly one generation.** Its binding is immutable:
`CORK()` names one pool manager, and the constructor requires the whitelist
manager of that same pool manager. Your deployed adapter is bound to
`phoenix/v0.3-rc.1`. It fills and exercises there as before. For a pool on the
primary the tool refuses `adapter_binding_mismatch` and builds nothing. To trade
on the primary you deploy a second adapter, bound to the new pool manager, and
whitelist it beside the first (step 7). One adapter address per generation;
keep the old one whitelisted until your last `v0.3-rc.1` cover is exercised or
expired.

## The path

Work the steps in order. Each is small; nothing here should take a day. If you
integrated against `v0.3-rc.1`, steps 1–4 are a re-read, and step 7 is the one
with new work.

| # | Step | Where the detail lives |
|---|---|---|
| 1 | **Read the manifest** for `phoenix/v0.4-rc.1`: components, chains, review level, known issues, external dependencies (1inch LOP v4, Bundler3, Permit2). | [The manifest](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.4-rc.1.json) |
| 2 | **Install `cork-cli` at the pinned tag** (`v0.6.0`) and add its MCP server to your agent. Verify the asset against the release's `checksums.txt` or its build attestation. | Quickstart §4 (the integration kit); [v0.6.0 release](https://github.com/Cork-Technology/cork-cli/releases/tag/v0.6.0) |
| 3 | **Self-test the install.** A healthy install answers exactly **9 tools**; 8 are read-only, only `cork_submit` writes. Expected-failure reason codes (`pool_not_found`, `unavailable`, …) are documented answers, not broken installs. | [cork-cli README](https://github.com/Cork-Technology/cork-cli/blob/v0.6.0/README.md) |
| 4 | **Read live state on Base** — `ch query protocol-config` (both generations, every block's addresses and wire), registered assets, recipes. This is where addresses come from, every time. Then read your own positions: `ch query account-state --account <safe>` with no pool id lists your cST/cPT across every generation, with expiry and generation per row. Venue-backed list reads run in **hybrid** mode: every row carries `verification: "confirmed" \| "unverified"`, and rows the chain refutes are dropped — prefer confirmed rows, and treat `unverified` as a labeled state, not an error. | Quickstart §3; [`ch` reference](https://github.com/Cork-Technology/cork-cli/blob/v0.6.0/docs/cli.md); `cork_capabilities topic:"migration"` |
| 5 | **Walk the cover flow end to end** on Base: derive the market, open the RFQ (off-chain, through the tool — quickstart §3 step 1), verify and simulate the underwriter's order, then sign and broadcast the fill **from your own stack** — the tooling builds unsigned artifacts and relays venue postings; it never signs, never broadcasts a fill, never holds funds. Four rules learned from your live trades (2026-09-10 and 2026-09-30): send the full `oracle_params` block with an inline market template (`cork-inline-liquidity/1`: `schema`, `anchor_rate`, `expiry`, `swap_fee_wad`, `unwind_swap_fee_wad` — an empty block gets quoted but never rested); on v0.4 markets set `oracle_recipe` to the `phoenix/v0.4-rc.1` recipe from `ch query protocol-config`, never the v0.3 one — underwriters trade one generation, and a v0.3 recipe gets a pass even with a full block (the tool warns `recipe_generation_notice` on rfq-open, but your agent opens RFQs from its own context, so read this line as the guard); read the book with **your adapter as `filters.account`**, so the ranked view classifies each order's reservation against the address that will call the LOP; and treat a reserved order as unfillable on your route — see "Reserved orders" below. `premiumAnnualized` (`"0.041"` = 4.1%) is the one listing field; the legacy percent `premium` is refused. An unanswered RFQ means no underwriter is quoting that pair yet — coordination, not an error; raise it. | Quickstart §2–§3; `cork_capabilities topic:"orders"` |
| 6 | **Read quickstart §5 (Risks & ownership) in full** before touching the whitelist. Items A–C are the security core: the receiver argument your whitelist can't see, the pool whitelist being off by construction, and which spender each approval goes to. D–G (no slippage guard on exercise, REF pauses freezing cover, reconcile discipline, address and generation drift) shape your monitoring. | Quickstart §5 |
| 7 | **Deploy your receiver-forcing adapter for the primary generation** from `cork-periphery v0.2.0-rc.1` (`CorkForSelfAdapter`: 14 entrypoints, the 13 pool actions plus `fillOrderForSelf`; the ForSelf source is unchanged since `v0.1.1`, so the adapter you deployed from that tag is the same code — **but its binding is to the previous generation**). Constructor: `(cork, whitelistManager, lop)` — the primary's pool manager and whitelist manager, read live from `ch query protocol-config`, and the chain's LOP; the constructor checks `whitelistManager.CORK_POOL_MANAGER() == cork`. The package ships no deploy script: deploy with your own reviewed tooling, then read `CORK()`, `WHITELIST()` and `LOP()` back from the chain and record the code hash. Audit and vet it first — see the trust boundary below. | [`cork-periphery`](https://github.com/Cork-Technology/cork-periphery/tree/v0.2.0-rc.1) README ("Deploying"); quickstart §6 item 2 |
| 8 | **Whitelist each adapter's selectors in your Guarded Executor** — and only those. The selectors are the same on both adapters; the target address differs per generation. The adapter exists because your whitelist constrains contract + function, not arguments. Wire the approvals for your route (adapter route: CA/REF/cST to the adapter, nothing to the LOP or pool manager). Two machine-readable surfaces state the grants: LOP-order prepares (the fill) carry `data.approvals` — holder, token, spender, amount, and the unsigned approve payload, annotated against live allowances when an RPC resolves — and every forSelf artifact (exercise included) names its per-action sizing inputs in `data.forSelf.allowances`. Build your approval legs from them. | `cork-periphery` README ("The problem these solve", allowance matrix); quickstart §5 item C, §6 item 3 |
| 9 | **Run the exercise leg.** The buy leg ran live on 2026-09-10 (Base mainnet, test size); the cover expired unexercised. The next test is an exercise before expiry, or a rollover. Size it with `ch compute cst-swap-rate`, build it with `ch exercise --for-self`, dry-run it with `ch track simulate`, then gate the broadcast on an `eth_call` of the whole guarded batch (approvals plus the adapter call). Reconcile via `ch track reconcile` — one `--subject` per call, the receipt then the order — and the venue API. | Quickstart §3 step 4, §6; [API docs](https://api-phoenix.cork.tech/docs) |
| 10 | **Close the loop with Cork** — the checklist at the bottom of this document, both directions. | Below |

## Reserved orders — what Cork does about the adapter

An underwriter may reserve a resting order for one fill sender (the LOP's
`allowedSender`). The LOP compares that address with the address that **calls**
it. On your route that caller is your adapter, not your Safe. So an order
reserved for your Safe is unfillable for you.

What the pinned tool does:

- The venue's RFQ record carries no fill-sender field (cork-api `0.4.3`), so an
  underwriter answering through the tool (`answer-rfq`) cannot learn your
  adapter address from the request. The tool then builds the answer **open**
  and says so (`fill_sender_unknown`); it never guesses a reservation. An
  underwriter who knows your adapter can pass it as `fillSender` and reserve
  the order for it.
- Your book read, with the adapter as `filters.account`, classifies every row:
  an order reserved for another sender is listed under `excluded`, never
  ranked. A fill prepare for such a row refuses `private_order` with no bytes.

If a quote you accepted rests reserved for your Safe, tell us: the fix is on the
underwriter's side (rest it open, or reserve it for your adapter). We track the
venue-side field that would close this gap.

## The trust boundary — you own your adapter

Cork deploys nothing into your trust path. `cork-periphery` ships **reference**
adapters; you audit, vet and deploy your own copy under your own name. The
manifest's `cork-periphery` entry records Cork's reference deployment for each
generation **so you can diff your deployment against it** — not so you can
whitelist Cork's.

The standard these contracts are written to, stated once and worth keeping:
**"Zyfai-owned" is the trust anchor, not the safety property.** The safety
property is *receiver-forcing + custody-free + audited*. All three, not the
ownership, are what make the adapter safe to sit inside your cage.

Two exposures the adapter deliberately does **not** close, so plan for them:

- **Price risk** — the adapter bounds *where* value goes, not *whether* a trade
  is wise. Amounts, market choice and premium stay agent-chosen; your allowance
  sizing is the real lever. Keep allowances just-in-time or capped.
- **Raw ERC-20 transfers of cST/cPT** — a caller-chosen destination *is* the
  ERC-20 semantics; no adapter can fix it. Close it in your executor's
  recipient/spender allowlists, and note cST/cPT are per-market tokens, so a
  static token allowlist needs an entry per market. Plan that operational
  process before scaling past pilot size.

## What this Distribution is, honestly

Stated in the manifest; repeated here so nobody discovers it late:

- **`partner-preview`, review level `unreviewed`, no audits.** Best-effort
  support, no production commitment. The cross-component integration suite is
  **waived, not passed**: the Distribution owner waived it on 2026-09-25
  because no cross-component integration runner exists yet (deviation D10 in
  the manifest). No passing integration run is claimed. The nearest evidence is per-component: signed
  builds, checksums, attestations, the finalized deployment reconciliation on
  both chains, and the tool's own fork rehearsal of a JIT fill on the new set.
  None of it is represented as a cross-component run. Read `support` and
  `knownIssues` from the manifest itself; they change in place.
- **Rollover is pinned, not proven.** Rollover `0.2.0` joins with its paired
  singleton stack and BaseFiller on both chains. It adds `oracleSalt` to the
  JIT commitment (a new signed typehash); the order data is unchanged, and the
  venue admits both settler generations. **No end-to-end rollover run is
  claimed**, its API route family is outside cork-api's covered route list, and
  the per-holder `CorkRolloverContract` clones are outside the pin. The
  mechanics and the role split (a cPT-holder signs the order; you are the
  filler) are taught in the quickstart's "After the flow" appendix; the tool
  builds only the **supply side** (`rollover-intent` / `rollover-order`), and
  the filler transaction stays in Zyfai's stack. Cover a position, exercise or
  expire; do not design around renewal being production-ready yet.
- **Deployed on both chains; integrate on Base first.** Base is where the
  partner path is proven; Arbitrum One carries the same addresses.

If any of these change, the notice channel is GitHub Releases on the pinned
repositories. This cut breaks every covered surface; the manifest spells the
changes out, and the README's "Moving from v0.3-rc.1" carries the ones a
demand-side integrator meets.

## Do not

- **Do not hardcode addresses** — not in code, not in docs, not in agent
  context. Read the manifest, or read live (`ch query protocol-config`).
  Retired deployments still answer calls and decode into plausible nonsense.
- **Do not point an adapter at a market of the other generation.** The tool
  refuses the pairing (`adapter_binding_mismatch`); the on-chain call would
  revert. One adapter per generation, and check `data.generation` on every
  pool read before you prepare through an adapter.
- **Do not whitelist raw `CorkPoolManager` or the raw 1inch LOP** in your
  executor. Whitelist your deployed adapters' selectors instead.
- **Do not approve cST (or cPT) to the pool manager.** Such an approval can
  never legitimately be spent — the pool manager's internal transfer path skips
  the allowance check when the token's owner is the caller — so it only sits
  there as standing risk. On the adapter route, every approval goes to your
  adapter; the exact grants per action are machine-readable in the prepared
  artifact (`data.approvals`, with `data.forSelf.allowances` naming the sizing
  inputs).
- **Do not send the legacy percent `premium` field anywhere.** The venue
  removed it on 2026-08-17 and `cork-cli` refuses it locally with the fraction
  to send instead. `premiumAnnualized` is the one premium field.
- **Do not send an empty `oracle_params` block with an inline market
  template.** The underwriter cannot derive a market from it; the RFQ gets
  quoted but no order comes to rest. The full block is in the quickstart.
- **Do not name a v0.3 recipe in `oracle_recipe` for a v0.4 market.** On
  `phoenix/v0.4-rc.1` markets the recipe is the v0.4 one from `ch query
  protocol-config` (`marketRegistry.recipes`), never the v0.3 address. An
  underwriter that trades v0.4 passes a v0.3 recipe even with a full
  `oracle_params` block (live, 2026-09-30). rfq-open warns
  `recipe_generation_notice`; the agent that opens the RFQ must read it.
- **Do not infer the chain from an address.** Cross-chain address identity is a
  CREATE2 property, not a chain signal; select the chain explicitly.
- **Do not trust any document over the manifest** on versions or addresses —
  and **never copy an address out of a doc's example output**, however fresh
  the capture. Pull authoritative values from `ch query`, never from prose.
- **Do not use anything from this repository's git history.** The pre-August
  material targets deleted entrypoints and dead deployments.

## Checklist

What Zyfai does:

1. Read the manifest; confirm the pin (`phoenix/v0.4-rc.1`) in your own notes.
2. Install `cork-cli@v0.6.0`, add the MCP server, pass the 9-tool self-test.
3. Read your positions across both generations; run the read/derive/prepare
   flow on Base against live state.
4. Audit and deploy your `CorkForSelfAdapter` for the primary generation;
   whitelist its selectors beside the existing adapter's.
5. Run the exercise leg on a live cover, at pilot size, and reconcile it.

What Cork needs back:

1. **Confirmation of your executor model** — that the Guarded Executor
   constrains contract + function but not arguments. The adapter design rests
   on this; if it's wrong in either direction, say so before deploying.
2. **The pilot asset list** — the 3–4 USDC pools, drawn from your exclusion
   list, that the first markets should cover. Your first trade covered
   USDC / ycsUSDC; confirm it and name the others.
3. **Adapter ownership and timeline** — who audits and deploys your adapter
   copies, and when, so market seeding on the primary can be scheduled against
   the second adapter.
4. **When you plan the first exercise** — so an underwriter can rest a market
   with enough time to expiry.
5. **Anything that reads wrong in the pinned docs** — file it on the relevant
   repository, or raise it directly. Security findings: security@cork.tech.
