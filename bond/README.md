# Bond underwriting agent

**Placeholder — to be built by Bond.**

The supply side of the pilot: Bond's keeper/underwriting agent. It answers
requests for quote, prices the risk slice from its underwriting engine, returns a
signed EIP-712 limit order to Cork's order book, and holds the `cPT` (Cork
Principal Token) underwriting leg — earning baseline stablecoin yield while parked
plus the upfront premium on each fill.

This is the counterpart to the [`zyfai/`](../zyfai/) trading (demand) agent: one
buys `cST` coverage, the other underwrites it, and the two discover a price through
the RFQ → signed quote → on-chain settlement loop. See [`PROJECT.md`](../PROJECT.md)
for the full flow.

## Integrating Cork

Both agents operate Cork through the same surface:

- The [`cork-operations`](../.claude/skills/cork-operations/) skill — the agent
  playbook for market creation, pool actions, and the coverage-order ceremony.
- The [`cork/`](../cork/) package — the on-chain contracts and the off-chain
  ceremony examples under `cork/docs/examples/`.

Bond's underwriting logic (RFQ scoring, floor pricing, signed-quote generation)
goes here.
