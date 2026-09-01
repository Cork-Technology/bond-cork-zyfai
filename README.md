# Zyfai × Cork — integration workspace

This repository is where Zyfai integrates Cork cover. Zyfai's own code lives in
[`zyfai/`](./zyfai/) and is owned by the Zyfai team. Everything else here is the
integration foundation contributed by Cork: orientation, the runbook, and agent
context — pinned to one released Cork Distribution.

> **Status** — 2026-09-01. Pinned to Distribution **`phoenix/v0.3-rc.1`**
> (stage `partner-preview`, review level `unreviewed`). Chains: Arbitrum One
> (42161) and Base (8453); integrate on **Base first**. Every contract address
> from `v0.2-rc.1` is unchanged in this pin — the cut is additive on contracts
> (rollover joins) and breaking on the CLI/MCP and API surfaces; see "Moving
> from v0.2-rc.1" below. The earlier hackathon integration package that used to
> live here is removed — see "What happened to the hackathon code" below.

## The one number to track

Everything you integrate against is pinned by a single name:

**[`phoenix/v0.3-rc.1`](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.3-rc.1.json)**
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
| The full walkthrough with runnable commands | [Zyfai quickstart](https://github.com/Cork-Technology/cork-cli/blob/v0.4.1/docs/zyfai-quickstart.md) (pinned to the released `cork-cli` tag; **orientation, not `v0.4.1` evidence** — its captured outputs date from `v0.2.0-rc.2`, per the manifest's scope note) |
| The CLI / MCP command reference | [`ch` reference](https://github.com/Cork-Technology/cork-cli/blob/v0.4.1/docs/cli.md) |
| The JIT-order contract, field by field | [`jit-order-anatomy.md`](https://github.com/Cork-Technology/cork-cli/blob/v0.4.1/docs/jit-order-anatomy.md) — chain-agnostic and address-free |
| The venue / indexer API | [api-phoenix.cork.tech/docs](https://api-phoenix.cork.tech/docs) |
| The receiver-forcing adapter you will deploy | [`cork-periphery`](https://github.com/Cork-Technology/cork-periphery/tree/v0.1.3-rc.1) at `v0.1.3-rc.1` (unchanged from `v0.2-rc.1`) |
| The rollover component's frozen deployment record | [rollover `v0.1.0-rc.2` release](https://github.com/Cork-Technology/rollover/releases/tag/v0.1.0-rc.2) — pinned, with caveats; see below |
| What exactly is deployed, and its assurance | [The manifest](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.3-rc.1.json) |

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

## Moving from v0.2-rc.1

On contracts, `v0.3-rc.1` is additive: **every phoenix, market-registry and
ForSelf contract address and codehash from `v0.2-rc.1` is unchanged**, so an
adapter deployed against `v0.2-rc.1` stays valid. On the CLI/MCP and API
surfaces the cut is **breaking** — the manifest records the Distribution
owner's explicit exception (COR-172) to cutting a new line for it. What
changed:

- **`cork-cli` `0.2.0-rc.2` → `0.4.1`, breaking.** Install the new tag; the
  release-gate evidence for it is in the manifest. Three covered changes:
  1. The data mode and JSON provenance value `centralized` is renamed
     **`hybrid`** — and the mode now earns the name: venue-backed list reads
     run a chain-verification leg, every row carries
     `verification: "confirmed" | "unverified"`, and a row the chain refutes
     is dropped and counted. The old value gets a teaching error.
  2. The legacy percent-number `premium` listing field is **refused locally**
     (the venue removed it on 2026-08-17). `premiumAnnualized` — an annualized
     decimal-fraction string, `"0.041"` = 4.1% — is the one premium field.
  3. Rollover artifacts use the pinned rc.2 `jitMarketHash` wire; pre-rc.2
     rollover digests do not verify on any deployed settler.

  Also worth knowing, from the pinned
  [CHANGELOG](https://github.com/Cork-Technology/cork-cli/blob/v0.4.1/CHANGELOG.md):
  every LOP-order prepare result now carries `data.approvals` — one entry per
  required grant with holder, token, spender, amount and the **unsigned
  approve payload**, annotated against live on-chain allowances when an RPC
  resolves; `taker-fill` accepts an inline `signedOrder` (a venue-free fill of
  bytes in hand); and the LOP liveness pre-flight now reads the correct
  invalidator word (COR-175), so a cancelled or filled order can no longer
  prepare as fillable.
- **`cork-api` `0.3.6` → `0.4.0`.** A version-stamp-only promotion: the 0.4.0
  interface is byte-identical to 0.3.16 apart from the version stamp, and the
  jump includes the noticed 2026-08-17 legacy-`premium` removal. No route,
  schema or database changes. The rollover API route family remains **outside**
  cork-api's covered route list.
- **`rollover` `0.1.0-rc.2` joins the Distribution** — the paired
  Arbitrum/Base singleton stack and BaseFiller, with the public release commit
  verified byte-identical to the deployed runtime bytecode on both chains. The
  caveats are recorded in the manifest and repeated in the runbook: **no
  end-to-end rollover run is claimed**, its API family is not covered, and
  `EvcRolloverAdapter` plus the per-holder clones sit outside the pin.
- **`phoenix`, `market-registry`, `cork-periphery` are unchanged** at
  `1.3.0-rc.1`, `0.3.3` and `0.1.3-rc.1`. The indexer has nothing to re-point.

## Notices and security

- **Change notice channel:** GitHub Releases on each public repository the
  manifest pins. Watch them; deprecations and removals are announced there.
- **Security contact:** security@cork.tech.

## What happened to the hackathon code

Until August 2026 this repository carried the July hackathon package: contracts
(`CorkMarketCreator`, an early LOP adapter), examples, and an agent skill with a
hardcoded address book. All of it described deployments that no longer exist and
entrypoints that were deleted upstream. It was removed rather than patched, and
remains reachable in git history — **do not integrate against anything found
there**, and do not let an agent resurrect it from history.
