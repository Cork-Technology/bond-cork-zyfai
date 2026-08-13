---
name: cork-integration
description: Operate Cork Distribution phoenix/v0.1-rc.1 through the cork-cli MCP server — read protocol state, derive markets, build and verify unsigned order artifacts, and run the cover flow. Use for any task that touches Cork markets, cST/cPT, quotes, orders, fills, or exercise.
---

# Operating Cork phoenix/v0.1-rc.1

This skill replaces the retired `cork-operations` skill, whose address book
pointed at deployments that no longer exist. This skill deliberately carries
**no addresses and no API payloads**: the tool surface is self-documenting and
reads live state, so the skill's job is wiring, sequencing, and guardrails.

## Setup

Requires the cork-cli MCP server at the pinned tag **`v0.1.0-rc.3`**. Install
and MCP registration:
[quickstart §"the integration kit"](https://github.com/Cork-Technology/cork-cli/blob/v0.1.0-rc.3/docs/zyfai-quickstart.md).
Known drift in that quickstart: its example outputs show the superseded `0.3.2`
contract generation ([cork-cli#1](https://github.com/Cork-Technology/cork-cli/issues/1))
— never treat an address printed there as current; read addresses live.
Self-test: a healthy install answers **exactly 9 tools**. If it doesn't, fix
the install before doing anything else — do not work around a partial surface.

## The tool surface and its trust model

Nine tools; the taxonomy is the trust model:

- `cork_query` — read live chain + venue state. `cork_compute` — deterministic
  math over verified state. `cork_decode` — bytes to labelled JSON.
  `cork_capabilities` — the searchable manual. `cork_track` — verify,
  simulate, reconcile. All read-only.
- `cork_prepare_phoenix` / `cork_prepare_orders` / `cork_prepare_market` —
  build **unsigned** bytes or typed data for later signing. They execute
  nothing.
- `cork_submit` — **the only side-effecting tool.** It relays an
  already-signed payload; it never signs and never holds a key.

Signing and key custody stay in the caller's stack, always.

## Decision rules

1. **Start unfamiliar tasks with `cork_capabilities`.** It is the manual and
   maturity map; discover the right tool rather than guessing one.
2. **Read, never remember.** Addresses, rates, registered assets and recipes
   come from `cork_query` at the moment of use. Anything remembered from a doc,
   a prior session, or this repository's history is presumed stale.
3. **The manifest is the authority on versions.**
   [`phoenix/v0.1-rc.1`](https://github.com/Cork-Technology/distribution/blob/main/distributions/phoenix/v0.1-rc.1.json)
   pins the set. If a tool, doc, or API self-reports something that contradicts
   it, stop and surface the mismatch instead of picking a side silently.
4. **Verify before submit.** Run the `cork_track` verification/simulation on a
   prepared artifact before it is signed, and never call `cork_submit` with a
   payload you did not just verify. Every prepared artifact carries a
   `data.execution` block naming its exact completion path; the signing guide
   is `cork_capabilities topic:"signing"`. Note `cork_submit` relays venue
   postings (RFQs, orders) — a *fill* is signed and broadcast from the caller's
   own stack, never through the tool.
5. **A reason code is an answer, not an error.** `unavailable`,
   `chain_read_failed`, `roles_not_granted` and similar are documented states —
   report them as findings; do not retry-loop or fabricate the missing result.
6. **Pricing is Zyfai's.** The tooling has no pricing model by design. Premium
   acceptance logic belongs in Zyfai's stack; never derive "a fair premium"
   from the tool and present it as authoritative.
7. **Chain is explicit.** Both chains share addresses; every query and every
   prepared artifact names its chain id. Base (8453) is the default working
   chain for this integration.

## Escalation

- Tool or doc contradicts the manifest → report to the humans, cite both.
- Anything that smells like a security issue → security@cork.tech, and stop
  work on the affected path.
- A needed capability is gated or missing → say so plainly; do not emulate it
  with raw RPC calls that bypass the tool's verification.
