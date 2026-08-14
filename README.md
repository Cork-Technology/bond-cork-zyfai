# Zyfai × Cork — integration workspace

This repository is where Zyfai integrates Cork cover. Zyfai's own code lives in
[`zyfai/`](./zyfai/) and is owned by the Zyfai team. Everything else here is the
integration foundation contributed by Cork: orientation, the runbook, and agent
context — pinned to one released Cork Distribution.

> **Status** — 2026-08-14. Pinned to Distribution **`phoenix/v0.2-rc.1`**
> (stage `partner-preview`, review level `unreviewed`). Chains: Arbitrum One
> (42161) and Base (8453); integrate on **Base first**. Every contract address
> from `v0.1-rc.1` is unchanged in this pin — see "Moving from v0.1-rc.1"
> below. The earlier hackathon integration package that used to live here is
> removed — see "What happened to the hackathon code" below.

## The one number to track

Everything you integrate against is pinned by a single name:

**[`phoenix/v0.2-rc.1`](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.2-rc.1.json)**
in [`Cork-Technology/distribution`](https://github.com/Cork-Technology/distribution).

That manifest names the exact component versions, per-chain addresses and
codehashes, vendored ABIs, the third-party contracts the set was built against,
what review the set carries, and its known issues. Two rules follow:

1. **The manifest is the authority.** Where any document — including the ones
   linked below — disagrees with the manifest on a version or an address, the
   manifest wins.
2. **Read living facts fresh.** `stage`, `reviewLevel`, `support`, `status` and
   `knownIssues` can change in place. Read them from the distribution repo at
   the moment you need them, never from a copy.

There are deliberately **no contract addresses anywhere in this repository**.
Hand-copied address tables are how the previous integration package went stale
while still looking authoritative. Addresses come from the manifest, or live
from the tool (`ch query protocol-config`).

## Start here

| You want | Read |
|---|---|
| The integration path, start to finish | [`INTEGRATION.md`](./INTEGRATION.md) — the runbook for this workspace |
| The full walkthrough with runnable commands | [Zyfai quickstart](https://github.com/Cork-Technology/cork-cli/blob/v0.2.0-rc.2/docs/zyfai-quickstart.md) (pinned to the released `cork-cli` tag; its live outputs were re-captured 2026-08-12 against the pinned `0.3.3` contracts) |
| The CLI / MCP command reference | [`ch` reference](https://github.com/Cork-Technology/cork-cli/blob/v0.2.0-rc.2/docs/cli.md) |
| The JIT-order contract, field by field | [`jit-order-anatomy.md`](https://github.com/Cork-Technology/cork-cli/blob/v0.2.0-rc.2/docs/jit-order-anatomy.md) — chain-agnostic and address-free |
| The venue / indexer API | [api-phoenix.cork.tech/docs](https://api-phoenix.cork.tech/docs) |
| The receiver-forcing adapter you will deploy | [`cork-periphery`](https://github.com/Cork-Technology/cork-periphery/tree/v0.1.3-rc.1) at `v0.1.3-rc.1` |
| What exactly is deployed, and its assurance | [The manifest](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.2-rc.1.json) |

Agents working in this repository get their context from [`CLAUDE.md`](./CLAUDE.md)
and operate Cork through the [`cork-integration`](./.claude/skills/cork-integration/SKILL.md)
skill, which wires the `cork-cli` MCP (Model Context Protocol) server.

## Layout

```
zyfai/                            Zyfai's integration code. Zyfai-owned; Cork does not edit it.
INTEGRATION.md                    The runbook: the path, the trust boundary, the checklist.
CLAUDE.md                         Context for agents working in this repository.
.claude/skills/cork-integration/  Agent skill for operating the pinned Cork Distribution.
```

## Moving from v0.1-rc.1

`v0.2-rc.1` is a new point on the same line — no covered surface broke, and
**every phoenix, market-registry and ForSelf contract address and codehash from
`v0.1-rc.1` is unchanged** (re-verified on-chain 2026-08-14, per the manifest).
An adapter deployed against `v0.1-rc.1` stays valid. What did change:

- **`cork-cli` `0.1.0-rc.3` → `0.2.0-rc.2`.** Install the new tag. The venue's
  premium field migrated: read and write `premium_annualized` (annualized
  decimal-fraction string, `"0.041"` = 4.1%); the legacy percent `premium` is
  deprecated and **the venue removes it on 2026-08-17**. Full change record:
  the pinned [CHANGELOG](https://github.com/Cork-Technology/cork-cli/blob/v0.2.0-rc.2/CHANGELOG.md)
  entries for `0.2.0-rc.1` and `0.2.0-rc.2`.
- **`cork-api` `0.1.4` → `0.3.6`.** Canonical paths are module-scoped
  (`/limit-orders/v1/…`, `/registry/v1/…`); the legacy `/v1/*` form is served
  only through a deprecation-tagged rewrite bridge. If you call the REST API
  directly, move to the canonical form; through `ch` this is already handled.
- **`cork-periphery` `0.1.1` → `0.1.3-rc.1`, additive.** `CorkMarketCreator`
  joins the component; the ForSelf adapter sources are unchanged between the
  two tags.
- **The registry read API joined the Distribution** as the cork-api registry
  module — the v0.1 scope note excluding it is closed.

## Notices and security

- **Change notice channel:** GitHub Releases on each repository the manifest
  pins. Watch them; deprecations and removals are announced there.
- **Security contact:** security@cork.tech.

## What happened to the hackathon code

Until August 2026 this repository carried the July hackathon package: contracts
(`CorkMarketCreator`, an early LOP adapter), examples, and an agent skill with a
hardcoded address book. All of it described deployments that no longer exist and
entrypoints that were deleted upstream. It was removed rather than patched, and
remains reachable in git history — **do not integrate against anything found
there**, and do not let an agent resurrect it from history.
