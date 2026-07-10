# Worked examples — the order layer, end to end

Runnable references for agent developers (node 20+, `npm i viem`). The
ceremony in four moves; market creation itself is covered in
[`../integration.md`](../integration.md).

**Start with [`ceremony.md`](./ceremony.md)** — the end-to-end flow as it
will actually run (Zyfai's Safe creates + quotes, Bond takes or counters,
JIT throughout, and the EOA-vs-CONTRACT maker rule that decides both the
signature verification and the fill function).

Then the two order shapes, one ceremony — a ladder, each step changing one
thing:

| Step | Walkthrough | Scripts | What it adds |
|---|---|---|---|
| 1. Plain | `plain-order.md` | `plain-order.mjs`, `plain-fill.mjs` | **START HERE** — vanilla 1inch orders, no extension, no custom contracts; the full URL ceremony |
| 2. JIT | `jit-order.md` | `jit-order.mjs`, `jit-fill.mjs`, `lift-bid.mjs` | extension pre-interaction slot → capital appears at the fill, no pre-deposit |
| 3. Contract maker | `contract-maker.md` | `contract-order.mjs`, `contract-fill.mjs` | maker is an ERC-1271 wallet (Safe stand-in) → raw-bytes signature + `fillContractOrderArgs`; same bytes otherwise |

And the ceremony itself as runnable scripts:

| Script | What it runs |
|---|---|
| `market-rfq.mjs` | ceremony steps 1+2 in one go: `createMarket` (the on-chain request for quote) + the opening BUY bid |
| `ceremony-e2e.mjs` | the WHOLE flow: create → opening bid → discovery → counter-ask → fill; discovery via `CORK_API_URL` or a local JSON handoff file (bare-fork mode); account type parameterized on both sides |

`lib.mjs` is shared by all: extension encoding (offsets header), salt
commitment, maker/taker traits bitfields (incl. the `orderExpiry` helper —
expiry lives inside makerTraits and every negotiation order needs one),
EIP-712 + compact signatures, and the known-errors ABI for decoded revert
messages — byte layouts verified against 1inch source.

All orderbook endpoints mount under `/v1`: `POST /v1/limit-orders`,
`GET /v1/limit-orders/orderbook`, `GET /v1/limit-orders/fills`,
`GET /v1/pools` (verified against `cork-indexing-api/src/infra/server.ts`).

All byte layouts in `lib.mjs` are verified against 1inch `limit-order-protocol`
master (`ExtensionLib`, `MakerTraitsLib`, `TakerTraitsLib`, `OrderLib`) — the
code deployed at the canonical `0x111111125421cA6dc452d289314280a0f8842A65`
(same address on Arbitrum One).

## The ceremony (who does what)

1. **Asker creates the market** (`CorkMarketCreator.createMarket`, whitelist
   OFF; `market-rfq.mjs` runs this step plus the opening bid) — this
   on-chain act IS the request for quote. The Cork indexer tails
   the chain to the tip and registers the new market automatically, normally
   within seconds (worst case one ~12s indexer idle cycle plus processing).
   If the API returns "no matching pool found", the market isn't indexed yet —
   retry with backoff, don't re-create.
2. Optionally the asker posts an opening **bid** (`jit-order.mjs` mirrored:
   makerAsset = CA, takerAsset = cST) — price
   and size in one artifact. A price-less "interest signal" also works: the
   market's existence is enough for underwriters to quote.
3. **Underwriter quotes**: `jit-order.mjs` — or lifts the bid directly with
   `lift-bid.mjs`.
4. **Asker fills** whichever ask clears its ceiling: `jit-fill.mjs`.

Convergence policy (so two polite agents actually trade): asker fills the best
ask at or under its ceiling, else improves its bid one notch; underwriter fills
any bid at or above its floor, else posts its ask at floor + margin. Cancels
cost gas — that is the anti-flip-flop incentive, not a bug.

## Approval matrix (one-time setup)

| Party | Approval | When |
|---|---|---|
| Underwriter | CA -> `CorkLimitOrderAdapter` | once per CA token |
| Underwriter | cST -> LOP | once per market (at pricing time) |
| Asker | CA -> LOP | once per CA token |

## The three errors you will actually hit

| Revert / rejection | Cause |
|---|---|
| `InvalidExtension` (on-chain) or "commitment mismatch" (API 400) | salt's low 160 bits do not equal keccak256(extension)'s low 160 bits, or the extension bytes passed at fill differ from the signed ones |
| `TakingAmountTooHigh` | threshold set below the order's static price — rebuild the fill with the correct threshold |
| `MintUnavailable` / whitelist revert | market created with `isWhitelistEnabled: true` (must be false), or the market expired |
