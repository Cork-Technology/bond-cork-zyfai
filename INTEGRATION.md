# Integrating Cork cover — the runbook

> **Audience:** Zyfai engineering, and the agents working on their behalf.
> **Assumes:** Safe / ERC-7579 smart accounts, 1inch Limit Order Protocol v4,
> EIP-712 / ERC-1271 signing, ERC-2612 permits, ERC-4626 vaults.
> **Chain:** Base (8453) first; everything transfers to Arbitrum One (42161) by
> changing the chain id and asset addresses.
> **Pin:** Distribution [`phoenix/v0.3-rc.1`](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.3-rc.1.json).
> **Status:** updated 2026-09-01 against that pin (first written 2026-08-11
> against `v0.1-rc.1`, re-pinned 2026-08-14 to `v0.2-rc.1`; what moved between
> the pins is in the README's "Moving from v0.2-rc.1"). If the pin has moved
> again, this document is orientation, not instruction — re-read the manifest
> first.

This document sequences the integration. It does not duplicate the reference
material: each step links the pinned document that carries the detail. The full
teaching walkthrough — Cork's model, the glossary, every command in runnable
form — is the
[Zyfai quickstart](https://github.com/Cork-Technology/cork-cli/blob/v0.4.1/docs/zyfai-quickstart.md);
this runbook is the spine that tells you what to do, in what order, and who owns
what. One drift caveat, straight from the manifest: the tag-pinned quickstart is
**orientation, not `v0.4.1` integration evidence** — its captured outputs date
from `v0.2.0-rc.2`, and its rollover appendix is not evidence for the newly
pinned rollover component. The standing rule absorbs this: pull authoritative
values from `ch query`, never from prose.

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

## The path

Work the steps in order. Each is small; nothing here should take a day.

| # | Step | Where the detail lives |
|---|---|---|
| 1 | **Read the manifest** for `phoenix/v0.3-rc.1`: components, chains, review level, known issues, external dependencies (1inch LOP v4, Bundler3, the CREATE2 factory). | [The manifest](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.3-rc.1.json) |
| 2 | **Install `cork-cli` at the pinned tag** (`v0.4.1`) and add its MCP server to your agent. Verify the asset against the release's published checksums or attestation. | Quickstart §4 (the integration kit); [v0.4.1 release](https://github.com/Cork-Technology/cork-cli/releases/tag/v0.4.1) |
| 3 | **Self-test the install.** A healthy install answers exactly **9 tools**; 8 are read-only, only `cork_submit` writes. Expected-failure reason codes (`chain_read_failed`, `unavailable`, …) are documented answers, not broken installs. | [cork-cli README](https://github.com/Cork-Technology/cork-cli/blob/v0.4.1/README.md) |
| 4 | **Read live state on Base** — `ch query protocol-config`, registered assets, recipes. This is where addresses come from, every time. Venue-backed list reads run in **hybrid** mode: every row carries `verification: "confirmed" \| "unverified"`, and rows the chain refutes are dropped — prefer confirmed rows, and treat `unverified` as a labeled state, not an error. | Quickstart §3; [`ch` reference](https://github.com/Cork-Technology/cork-cli/blob/v0.4.1/docs/cli.md) |
| 5 | **Walk the cover flow end to end** on Base: derive the market, open the RFQ, verify and simulate the underwriter's order, then sign and broadcast the fill **from your own stack** — the tooling builds unsigned artifacts and relays venue postings; it never signs, never broadcasts a fill, never holds funds. Premium fields are fractions now: `premiumAnnualized` (`"0.041"` = 4.1%) is the one listing field; the legacy percent `premium` is refused. An unanswered RFQ means no underwriter is quoting that pair yet — coordination, not an error; raise it. Confirm the RFQ package catalog and notional units with Cork before the first post. | Quickstart §2–§3 |
| 6 | **Read quickstart §5 (Risks & ownership) in full** before touching the whitelist. Items A–C are the security core: the receiver argument your whitelist can't see, the pool whitelist being off by construction, and which spender each approval goes to. D–G (no slippage guard on exercise, REF pauses freezing cover, reconcile discipline, address drift) shape your monitoring. | Quickstart §5 |
| 7 | **Deploy your own receiver-forcing adapter** from `cork-periphery v0.1.3-rc.1` (`CorkForSelfAdapter` is the one to deploy: one address to audit, whitelist and approve; its source is unchanged since `v0.1.1`, so an adapter already deployed from that tag stays valid). Audit and vet it first — see the trust boundary below. | [`cork-periphery`](https://github.com/Cork-Technology/cork-periphery/tree/v0.1.3-rc.1) README |
| 8 | **Whitelist the adapter's selectors in your Guarded Executor** — and only those. The adapter exists because your whitelist constrains contract + function, not arguments. Wire the approvals for your route (adapter route: CA/REF/cST to the adapter, nothing to the LOP or pool manager). Every LOP-order prepare states its grants in `data.approvals` — holder, token, spender, amount, and the unsigned approve payload — annotated against live allowances when an RPC resolves; build your approval legs from it. | `cork-periphery` README ("The problem these solve", allowance matrix); quickstart §5 item C, §6 item 3 |
| 9 | **Run one full cover cycle at pilot size** — buy cover, hold, exercise or let expire, reconcile via `ch track` and the venue API. Simulate every artifact before signing. | Quickstart §3, §6; [API docs](https://api-phoenix.cork.tech/docs) |
| 10 | **Close the loop with Cork** — the checklist at the bottom of this document, both directions. | Below |

## The trust boundary — you own your adapter

Cork deploys nothing into your trust path. `cork-periphery` ships **reference**
adapters; you audit, vet and deploy your own copy under your own name. The
manifest's `cork-periphery` entry records Cork's reference deployment **so you
can diff your deployment against it** — not so you can whitelist Cork's.

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
  support, no production commitment. The cross-component integration suite was
  waived again for this cut — this time as an explicit owner exception
  (COR-172, 2026-08-21) that overrides `v0.2-rc.1`'s statement that its waiver
  was final; a separate runner is being developed, and the manifest says the
  waiver must not be copied silently into another cut. The nearest evidence is
  per-component release gates (signed builds, checksums, attestations, smokes,
  on-chain bytecode verification), plus the Distribution's own live-surface
  verification — none of it is represented as a cross-component run.
- **Rollover is pinned, not proven.** The rollover component `0.1.0-rc.2`
  joins with its paired singleton stack and BaseFiller, verified byte-identical
  to the deployed runtime bytecode on both chains — but **no end-to-end
  rollover run is claimed**, its API route family is outside cork-api's covered
  route list, and `EvcRolloverAdapter` plus the per-holder
  `CorkRolloverContract` clones are outside the pin. Cover a position, exercise
  or expire; do not design around renewal being production-ready yet.
- **Admin and operational timelocks run at a 0-second delay** — a documented
  fact of this partner-preview deployment.
- **Deployed on both chains; integrate on Base first.** Base is where the
  partner path is proven; Arbitrum One carries the same addresses.

If any of these change, the notice channel is GitHub Releases on the pinned
repositories — breaking changes to a documented surface open a new Distribution
line, announced in advance. This cut itself carried covered breaking changes
under a recorded owner exception to that rule; the exception does not make them
non-breaking, which is exactly why the manifest spells them out.

## Do not

- **Do not hardcode addresses** — not in code, not in docs, not in agent
  context. Read the manifest, or read live (`ch query protocol-config`).
  Retired deployments still answer calls and decode into plausible nonsense.
- **Do not whitelist raw `CorkPoolManager` or the raw 1inch LOP** in your
  executor. Whitelist your deployed adapter's selectors instead.
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
- **Do not infer the chain from an address.** Cross-chain address identity is a
  CREATE2 property, not a chain signal; select the chain explicitly.
- **Do not trust any document over the manifest** on versions or addresses —
  and **never copy an address out of a doc's example output**, however fresh
  the capture. The pinned quickstart's captures predate this pin's tool; the
  rule exists so that never matters: pull authoritative values from `ch query`,
  never from prose.
- **Do not use anything from this repository's git history.** The pre-August
  material targets deleted entrypoints and dead deployments.

## Checklist

What Zyfai does:

1. Read the manifest; confirm the pin (`phoenix/v0.3-rc.1`) in your own notes.
2. Install `cork-cli@v0.4.1`, add the MCP server, pass the 9-tool self-test.
3. Run the read/derive/prepare flow on Base against live state.
4. Audit and deploy your `CorkForSelfAdapter`; whitelist its selectors only.
5. Run one full cover cycle at pilot size and reconcile it.

What Cork needs back:

1. **Confirmation of your executor model** — that the Guarded Executor
   constrains contract + function but not arguments. The adapter design rests
   on this; if it's wrong in either direction, say so before deploying.
2. **The pilot asset list** — the 3–4 USDC pools, drawn from your exclusion
   list, that the first markets should cover.
3. **Adapter ownership and timeline** — who audits and deploys your adapter
   copy, and when, so market seeding can be scheduled against it.
4. **Anything that reads wrong in the pinned docs** — file it on the relevant
   repository, or raise it directly. Security findings: security@cork.tech.
