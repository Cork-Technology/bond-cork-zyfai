# CLAUDE.md — agent context for this repository

## What this repository is

Zyfai's workspace for integrating Cork cover, pinned to Distribution
**`phoenix/v0.4-rc.1`**. `zyfai/` is Zyfai's own code. `INTEGRATION.md` is the
runbook — read it before doing any integration work. `README.md` maps the
pinned reference material.

## Hard rules

1. **The manifest is the authority.**
   [`distributions/phoenix/v0.4-rc.1.json`](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.4-rc.1.json)
   in `Cork-Technology/distribution` names every version, address, codehash and
   known issue. Where any document, code comment or memory disagrees with it,
   the manifest wins. Read living fields (`stage`, `reviewLevel`, `status`,
   `knownIssues`) fresh from the repo, never from a copy.
2. **Never write a contract address into this repository** — not in code, not
   in docs, not in comments. Read addresses live (`ch query protocol-config`
   via the cork-cli MCP) or from the manifest at the moment of use. If you find
   a hardcoded address here, that is a bug: remove it and cite the live source
   instead.
3. **Never resurrect anything from git history.** Pre-August history holds the
   hackathon package: deleted entrypoints (`CorkMarketCreator.createMarket`),
   retired adapter generations, dead addresses, and a stale `cork-operations`
   skill. None of it is a valid reference for any question about Cork.
4. **Signing stays in Zyfai's stack.** The cork-cli tooling reads state, does
   deterministic math, and builds *unsigned* artifacts; only `cork_submit`
   relays a signed payload, and nothing in it ever holds a key. Do not build or
   propose flows where the tooling signs or custodies funds.
5. **Do not edit `zyfai/` unless the task explicitly asks for it.** It is
   Zyfai's production-path code, not shared scaffolding.
6. **Name the generation you act on.** Since this pin a chain hosts two active
   contract generations: `phoenix/v0.4-rc.1` (the primary) and
   `phoenix/v0.3-rc.1` (the previous one). A read of an existing pool follows
   the pool's own generation. A prepare targets the primary unless you pass
   `generation` (a label, or the alias `previous`). Every result names the
   generation it answered from in `data.generation`; check it before you act.
   Zyfai's deployed `CorkForSelfAdapter` is bound to `phoenix/v0.3-rc.1`; it
   cannot serve a market on the primary. The tool refuses that pairing
   (`adapter_binding_mismatch`); do not work around the refusal.

## Operating Cork

Use the [`cork-integration`](./.claude/skills/cork-integration/SKILL.md) skill.
It wires the cork-cli MCP server (pinned tag `v0.6.0`) and carries the
decision rules. The tool surface is self-documenting: start any unfamiliar task
with `cork_capabilities`, not with a guess.

## Chains

Deployed on Arbitrum One (42161) and Base (8453) at identical addresses.
**Base first** — it is the proven partner path. Never infer the chain from an
address; select it explicitly.
