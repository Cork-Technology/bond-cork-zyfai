# The ceremony — Zyfai asks, Bond answers (start here)

The end-to-end flow as it will actually run, with exact calls. Zyfai's agent
is a **Safe** (a CONTRACT maker — this matters twice, see the rule below);
Bond's underwriting bot is an EOA. Just-in-time minting via
`CorkLimitOrderAdapter` is on from the start: **nobody deposits anything
until a trade actually happens.**

Orderbook API base (set `ORDERBOOK_URL` to this): **`https://api-phoenix.cork.tech`**
(all endpoints under `/v1`). Chain: Arbitrum One (42161).

Companion video: `43-ceremony-flow-example` (same steps, same numbers).
Deep-dives per order shape: [plain](./plain-order.md) →
[JIT](./jit-order.md).

---

## Step 1 — Zyfai creates the market (this IS the request for quote)

One transaction through `CorkMarketCreator.createMarket`: CA, REF (the
tokenized position), 24h expiry, rate fixed at creation, and
`isWhitelistEnabled: false` — non-negotiable, or every JIT mint reverts
later. Costs gas, which is what makes it a credible ask. The indexer has the
market on `GET /v1/pools?chainId=42161` within seconds (retry on miss, never
re-create).

## Step 2 — Zyfai posts its opening quote (a BID, from the Safe)

`makerAsset = CA` (the premium it offers), `takerAsset = cST` (the size it
wants). The backend EOA signs the EIP-712 order, but the **maker is the Safe
address**, so the payload says `makerAccountType: "CONTRACT"` — and the API
verifies not by recovering a signer but by calling
`SAFE.isValidSignature(orderHash, sig)` and expecting the ERC-1271 magic
value (`0x1626ba7e`). Post to `POST /v1/limit-orders`; a 201 means the bid
rests on the book. No funds move — a signed order is a commitment, not a
transfer.

## The one rule: `makerAccountType` decides two things

| | EOA maker (Bond's bot) | CONTRACT maker (Zyfai's Safe) |
|---|---|---|
| API verification | ECDSA: recover signer == maker | ERC-1271: `maker.isValidSignature(hash, sig)` |
| fill function | `fillOrderArgs(order, r, vs, amount, takerTraits, args)` | `fillContractOrderArgs(order, signature, amount, takerTraits, args)` |
| signature travels as | two bytes32 words (EIP-2098 compact) | raw bytes, the contract validates |

Takers: read `makerAccountType` off the book and branch. The wrong variant
reverts `BadSignature`. Both ABIs are in [`lib.mjs`](./lib.mjs)
(`FILL_ORDER_ARGS_ABI` / `FILL_CONTRACT_ORDER_ARGS_ABI`).

## Step 3 — Bond discovers and prices

Two GETs on a cron: `GET /v1/pools?chainId=42161` for new markets,
`GET /v1/limit-orders/orderbook?chainId=42161&poolId=…&side=BUY&status=OPEN&status=PARTIALLY_FILLED`
for their resting bids. Each item carries amounts, signature, extension
bytes and `makerAccountType`. Run the model: **bid ≥ floor → take (path A);
below → counter (path B).**

## Step 4, path A — Bond takes the bid

The maker is a Safe → `fillContractOrderArgs`, signature as raw bytes. Bond
owes cST it does not hold, so it attaches the adapter as its (unsigned)
taker interaction: `args = bid.extension ++ packTargetAndData(ADAPTER,
poolId)`. Inside the single fill transaction, in this order:

1. **premium in** — the LOP pushes the maker asset: Zyfai's premium lands on Bond;
2. **JIT mint** — the adapter pulls the collateral from Bond into the market
   and mints cST + cPT back to Bond;
3. **delivery** — the LOP pulls the fresh cST from Bond to the Safe.

Atomic: any move fails → all three unwind. Script: [`lift-bid.mjs`](./lift-bid.mjs).
One-time prereqs: `CA -> adapter` and `cST -> LOP` approvals.

## Step 4, path B — Bond counters

Bond posts its own ask at its price: `makerAsset = cST`, adapter committed
in the **signed** extension this time (pre-interaction — now Bond is the one
who will owe cST at fill), salt committing to the extension,
`makerAccountType: "EOA"`. Script: [`jit-order.mjs`](./jit-order.mjs).

Zyfai accepts by filling: maker is an EOA → the Safe executes
`fillOrderArgs` with the compact `r/vs` split — the same rule, other branch.
Script: [`jit-fill.mjs`](./jit-fill.mjs).

## Counter-offers: new orders, never cancels

A counter-offer is simply a **new order posted via the API** at the adjusted
premium — Bond's path-B ask, or Zyfai improving its bid one notch. Nothing
is cancelled on-chain in the negotiation flow; after a counter, BOTH orders
rest on the book and **either side picks which one to fill** (Zyfai fills
Bond's ask, or Bond lifts Zyfai's bid — whoever moves first ends the
negotiation).

The consequence to design for: **a superseded order stays fillable until it
expires.** If Zyfai bids 0.015, then re-bids 0.018, an underwriter can still
fill the 0.015 bid — both are valid signed commitments. That is why **every
bid and ask in a negotiation sets an expiry** in its maker traits
(`orderExpiry()` in [`lib.mjs`](./lib.mjs); the LOP reverts `OrderExpired`
past it, and expiry is free — no transaction, no gas). Keep negotiation
orders short-lived (minutes, not hours) so a stale price cannot be picked
off; an on-chain `cancelOrder` exists for emergencies but costs gas and is
not part of this flow.

Runnable version of the whole loop — create → bid → discover → counter →
fill, both discovery modes, both account types:
[`ceremony-e2e.mjs`](./ceremony-e2e.mjs).

## Either path, same end state

Safe holds its cST cover (premium paid), Bond holds cPT + the premium, the
market holds the locked collateral until expiry. Take-vs-counter only
changes who moved last. Track it:
`GET /v1/limit-orders/fills?chainId=42161&orderHash=…` — the book syncs
within seconds of the on-chain event.
