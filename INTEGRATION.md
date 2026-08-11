# Integrating Cork cover — the runbook

> **Audience:** Zyfai engineering, and the agents working on their behalf.
> **Assumes:** Safe / ERC-7579 smart accounts, 1inch Limit Order Protocol v4,
> EIP-712 / ERC-1271 signing, ERC-2612 permits, ERC-4626 vaults.
> **Chain:** Base (8453) first; everything transfers to Arbitrum One (42161) by
> changing the chain id and asset addresses.
> **Pin:** Distribution [`phoenix/v0.1-rc.1`](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.1-rc.1.json).
> **Status:** written 2026-08-11 against that pin. If the pin has moved, this
> document is orientation, not instruction — re-read the manifest first.

This document sequences the integration. It does not duplicate the reference
material: each step links the pinned document that carries the detail. The full
teaching walkthrough — Cork's model, the glossary, every command in runnable
form — is the
[Zyfai quickstart](https://github.com/Cork-Technology/cork-cli/blob/v0.1.0-rc.3/docs/zyfai-quickstart.md);
this runbook is the spine that tells you what to do, in what order, and who owns
what.

## What you are integrating, in one paragraph

Cork lets your agent hold a high-yield USDC position its risk gate would
otherwise exclude, by buying **cST** — per-market cover that swaps the covered
(reference) asset for the collateral asset at a fixed rate, any time before the
market's expiry. Your agent requests quotes off-chain (RFQ, request-for-quote),
the underwriter answers with a signed 1inch limit order, and the fill settles
everything atomically on-chain — the market itself is created just-in-time by
the fill if it doesn't exist yet. If the underlying impairs, your agent
exercises the cST on-chain. Full model and glossary: quickstart §1–§2.

## The path

Work the steps in order. Each is small; nothing here should take a day.

| # | Step | Where the detail lives |
|---|---|---|
| 1 | **Read the manifest** for `phoenix/v0.1-rc.1`: components, chains, review level, known issues, external dependencies (1inch LOP v4, Bundler3, the CREATE2 factory). | [The manifest](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.1-rc.1.json) |
| 2 | **Install `cork-cli` at the pinned tag** (`v0.1.0-rc.3`) and add its MCP server to your agent. | Quickstart §4 (the integration kit) |
| 3 | **Self-test the install.** A healthy install answers exactly **9 tools**; 8 are read-only, only `cork_submit` writes. Expected-failure reason codes (`chain_read_failed`, `unavailable`, …) are documented answers, not broken installs. | [cork-cli README](https://github.com/Cork-Technology/cork-cli/blob/v0.1.0-rc.3/README.md) |
| 4 | **Read live state on Base** — `ch query protocol-config`, registered assets, recipes. This is where addresses come from, every time. | Quickstart §3; [`ch` reference](https://github.com/Cork-Technology/cork-cli/blob/v0.1.0-rc.3/docs/cli.md) |
| 5 | **Walk the cover flow end to end** on Base: derive the market, request a quote, build the unsigned order artifacts, simulate, sign in *your* stack, submit the fill. The tooling never signs and never holds funds. | Quickstart §2–§3 |
| 6 | **Deploy your own receiver-forcing adapter** from `cork-periphery v0.1.1` (`CorkForSelfAdapter` is the one to deploy: one address to audit, whitelist and approve). Audit and vet it first — see the trust boundary below. | [`cork-periphery`](https://github.com/Cork-Technology/cork-periphery/tree/v0.1.1) README |
| 7 | **Whitelist the adapter's selectors in your Guarded Executor** — and only those. The adapter exists because your whitelist constrains contract + function, not arguments. | `cork-periphery` README ("The problem these solve", allowance matrix) |
| 8 | **Run one full cover cycle at pilot size** — buy cover, hold, exercise or let expire, reconcile via `ch track` and the venue API. | Quickstart §3, §6; [API docs](https://api-phoenix.cork.tech/docs) |
| 9 | **Close the loop with Cork** — the checklist at the bottom of this document, both directions. | Below |

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
  waived for this first cut (recorded in the manifest, with owner and date);
  the nearest evidence is cork-cli fork-proven end to end against the pinned
  stack.
- **Rollover is not part of this Distribution.** Cover a position, exercise or
  expire — renewal into a successor market is not shipped. Do not design
  around it existing.
- **Admin and operational timelocks run at a 0-second delay** — a documented
  fact of this partner-preview deployment.
- **Deployed on both chains; integrate on Base first.** Base is where the
  partner path is proven; Arbitrum One carries the same addresses.

If any of these change, the notice channel is GitHub Releases on the pinned
repositories — breaking changes to a documented surface open a new Distribution
line, announced in advance.

## Do not

- **Do not hardcode addresses** — not in code, not in docs, not in agent
  context. Read the manifest, or read live (`ch query protocol-config`).
  Retired deployments still answer calls and decode into plausible nonsense.
- **Do not whitelist raw `CorkPoolManager` or the raw 1inch LOP** in your
  executor. Whitelist your deployed adapter's selectors instead.
- **Do not approve cST to the pool manager.** The exercise path pulls through
  the adapter; a standing pool-manager approval is a standing risk.
- **Do not infer the chain from an address.** Cross-chain address identity is a
  CREATE2 property, not a chain signal; select the chain explicitly.
- **Do not trust any document over the manifest** on versions or addresses.
  Known instance today: the quickstart's status block still names
  market-registry `0.3.2`; the Distribution pins `0.3.3`. The quickstart's own
  rule covers you — pull authoritative values from the tool, never the prose.
- **Do not use anything from this repository's git history.** The pre-August
  material targets deleted entrypoints and dead deployments.

## Checklist

What Zyfai does:

1. Read the manifest; confirm the pin (`phoenix/v0.1-rc.1`) in your own notes.
2. Install `cork-cli@v0.1.0-rc.3`, add the MCP server, pass the 9-tool self-test.
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
