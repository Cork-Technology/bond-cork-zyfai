# JIT orders — same ceremony, capital appears at the fill

Step 2 of the ladder. Identical to [plain orders](./plain-order.md) in every
URL and every payload field, with ONE addition: the order carries an
**extension** whose pre-interaction slot points at `CorkLimitOrderAdapter`.
Result: the underwriter no longer pre-mints cST — collateral leaves its
wallet only in the same transaction as a fill, and only pro-rata to the
amount actually filled. Price is static.

## What changes vs plain — maker side (underwriter SELL)

| | plain | JIT |
|---|---|---|
| before posting | `approve CA -> poolManager`, `mint(poolId, size, me)` (capital locked while the order rests) | nothing minted; capital stays in the wallet |
| approvals | cST -> LOP | cST -> LOP **and CA -> adapter** (once per CA token) |
| extension | `""` | pre-interaction slot = `adapter ++ abi.encode(poolId)` |
| salt | anything unique | **low 160 bits = keccak256(extension) low 160 bits** (or fills revert `InvalidExtension`) |
| makerTraits | expiry + nonce + fills flags | same **+ HAS_EXTENSION (bit 249) + PRE_INTERACTION (bit 252)** |
| unfilled order expires | you hold cST+cPT you may not want (unwind = 1 tx) | nothing happened; zero cleanup |

At fill time, inside the LOP transaction and BEFORE the LOP pulls the cST,
the adapter pulls `previewMint(poolId, filledAmount)` of CA from the maker,
mints cST + cPT to the maker, and the fill proceeds — the maker keeps the
cPT (its underwriter leg) and receives the premium.

Run [`jit-order.mjs`](./jit-order.mjs):

```
PRIVATE_KEY=0x... ORDERBOOK_URL=... ADAPTER=0x... POOL_ID=0x... CST=0x... CA=0x... \
  CA_DECIMALS=6 SIZE_CST=20000000000000000000000 PRICE_CA_PER_CST=0.0000603 \
  node jit-order.mjs
```

## What changes vs plain — taker side

One thing only: because the order carries an extension, the taker must pass
those exact bytes in the fill and use `fillOrderArgs` (the `args` variant).
The bytes come straight off the book (`extension` field of the order); taker
traits encode their length. Price math is unchanged (static pro-rata).

Run [`jit-fill.mjs`](./jit-fill.mjs).

Taker-side JIT also exists: an underwriter lifting a hedger's BUY bid can
attach the adapter as its own (unsigned) `interaction` and mint its delivery
inside the fill — see [`lift-bid.mjs`](./lift-bid.mjs); it works against
plain and JIT bids alike.

| Script | Role | What it shows |
|---|---|---|
| [`lift-bid.mjs`](./lift-bid.mjs) | underwriter (taker) | lift a BID directly, minting the cST delivery via the (unsigned) taker interaction |

A JIT-liftable BID is a plain bid mirrored: `makerAsset = CA`,
`takerAsset = cST` — the taker interaction is the underwriter's own choice
at fill time, so the bidder signs nothing about it.

## Notes

- A JIT ask is all-or-nothing per fill leg: if the pool cannot mint at fill
  time (market expired or paused) the whole fill reverts (`MintUnavailable`)
  — the taker loses gas, nobody loses funds.
- The book stores and serves the extension verbatim; the API rejects at POST
  time any order whose salt does not commit to its extension, so a 400 there
  saves the taker a guaranteed on-chain revert later.
