# Plain orders — the ceremony with ZERO custom contracts

The simplest possible integration: a hedger or an underwriter trading cST
coverage with **vanilla 1inch LOP v4 orders** — no JIT
minting, no extension bytes at all. This is exactly how the production Cork
orderbook (LOP v1) trades today: static price, signed once, settled on the
audited canonical 1inch contract. Start here; graduate to
`CorkLimitOrderAdapter` (JIT minting) when the
pre-deposit limitation starts to hurt.

Assumes the market is already created (whitelist off) and you know its
`poolId`. All URLs below are the Cork orderbook API. Set `ORDERBOOK_URL` to the
live base: **`https://api-phoenix.cork.tech`**. The chain is Arbitrum One
(42161); the LOP is the canonical
`0x111111125421cA6dc452d289314280a0f8842A65`.

---

## The two roles

| | HEDGER (wants cover) | UNDERWRITER (sells cover) |
|---|---|---|
| posts | **BUY**: makerAsset = CA (the premium it pays), takerAsset = cST | **SELL**: makerAsset = cST, takerAsset = CA (the premium it earns) |
| must hold | CA | **cST — mint it first** (plain orders have no JIT; see step 1) |
| approves | CA → LOP, once per token | cST → LOP, once per market |

A resting order's price is frozen at signing (true for JIT orders too). Keep
plain orders short-lived (makerTraits expiry: minutes-to-hours) and re-post to
reprice — cancel costs gas, expiry is free.

---

## The ceremony, URL by URL

**0. Discover the pool's tokens** (once per market)

```
GET $ORDERBOOK_URL/v1/pools?chainId=42161
```

Find your pool by `poolId` in the response: it carries the CA
(`collateral`), cST (`swap`) and cPT (`principal`) token addresses. New
markets appear here automatically within seconds of creation (the indexer
tails the chain tip); if your market is missing, retry — never re-create.

**1. (Underwriter only) mint the cST you are about to sell**

Two txs against the pool manager — this is the pre-deposit the JIT adapter
eliminates, spelled out:

```js
await ca.approve(POOL_MANAGER, collateralIn);            // once
await poolManager.mint(poolId, cstShares, myAddress);    // mints cST + cPT to you
```

You now hold `cstShares` of cST (to sell) and the same amount of cPT (your
underwriter leg — keep it).

**2. Read the book before quoting**

```
GET $ORDERBOOK_URL/v1/limit-orders/orderbook?chainId=42161&poolId=<POOL_ID>&side=SELL&status=OPEN&status=PARTIALLY_FILLED
```

`side=SELL` lists resting asks (underwriters quoting); `side=BUY` lists bids
(hedgers asking). Each item carries the full signed order + signature —
everything needed to fill it.

**3. Build, sign and post your order**

Run [`plain-order.mjs`](./plain-order.mjs) (exact code, both roles):

```
SIDE=SELL PRIVATE_KEY=0x... ORDERBOOK_URL=... CST=0x... CA=0x... \
  CA_DECIMALS=6 SIZE_CST=20000000000000000000000 PRICE_CA_PER_CST=0.0000603 \
  node plain-order.mjs
```

What it does, precisely:
- **Order struct**: `{ salt, maker, receiver: 0, makerAsset, takerAsset,
  makingAmount, takingAmount, makerTraits }`. For a SELL:
  `makingAmount = SIZE_CST` (18 dec), `takingAmount = ceil(SIZE_CST x price)`
  in CA native decimals. For a BUY: mirrored.
- **salt**: any unique value (no extension → no commitment constraint).
- **makerTraits**: expiry (unix, low bits 80-119) + nonce (bits 120-159) +
  allow-partial + allow-multiple-fills. NO extension flag, NO interaction
  flags, nothing else.
- **Sign**: EIP-712, domain `{ name: "1inch Aggregation Router", version:
  "6", chainId: 42161, verifyingContract: LOP }`, primary type `Order`.
- **Post**:

```
POST $ORDERBOOK_URL/v1/limit-orders
content-type: application/json
{
  salt, maker, receiver, makerAsset, takerAsset,          // decimal strings / addresses
  makingAmount, takingAmount, makerTraits,                 // decimal strings
  orderHash,            // EIP-712 hash — the API recomputes and rejects mismatches
  signature,            // 65-byte hex
  makerAccountType: "EOA",   // or "CONTRACT" (ERC-1271) — checked against on-chain bytecode
  makerPermit2: "",
  extension: "",        // plain order: empty (field exists for adapter orders)
  side: "SELL",         // must match asset positions vs the pool, the API verifies
  premium: 2.2,         // display metadata (percent)
  expiry, nonce, allowsPartialFills,   // MUST match what makerTraits encodes — the API decodes and cross-checks
  chainId: 42161
}
→ 201 { "orderHash": "0x..." }
```

The API verifies everything (hash, signature, side vs pool, traits
consistency, max 5 open orders per maker per pool) — a 400 here always names
the exact mismatch.

**4. Counterparty fills on-chain**

Run [`plain-fill.mjs`](./plain-fill.mjs): pick an order from step 2, then one
tx to the LOP — `fillOrder(order, r, vs, amount, takerTraits)` (signature in
EIP-2098 compact form; no `args` needed since there is no extension). Taker
prerequisites: approve the taker-side asset to the LOP (CA when lifting a
SELL; cST when lifting a BUY — which you must hold or mint first).
Partial fills: pass any `amount <= remainingMakingAmount`.

**5. Watch the result**

```
GET $ORDERBOOK_URL/v1/limit-orders/fills?chainId=42161&orderHash=<HASH>
GET $ORDERBOOK_URL/v1/limit-orders/orderbook?chainId=42161&maker=<ME>&status=FILLED
```

The indexer picks the `OrderFilled` event off the chain and updates the
book's `status` / `remainingMakingAmount` within seconds.

**6. Cancel (optional)**

On-chain only — `cancelOrder(makerTraits, orderHash)` on the LOP from the
maker address. The book flips the order to `CANCELLED` when the indexer sees
the event. (Letting the makerTraits expiry lapse is the free alternative.)

---

## Plain vs adapter, one line each

- **Plain** (this doc): dead-simple, dapp-identical, but underwriters must
  pre-deposit capital per market.
- **Adapter** (`jit-order.mjs` / `jit-fill.mjs` / `lift-bid.mjs`): same
  ceremony, same URLs, plus a pre-interaction extension →
  capital moves only on fill.

Both kinds of orders coexist on the same book; takers can always tell them
apart by the `extension` field ("" = plain).
