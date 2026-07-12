# End-to-end runbook — bond.credit × Cork × Zyfai

This is the step-by-step guide to run the full pilot on **Arbitrum One shadow Phoenix**. It covers two paths:

1. **Simple MVP path** — a funded EOA creates the market and posts the opening bid. Fastest to get a fill.
2. **Production path (Section 7)** — the **Zyfai Safe** is the bid maker, and a separate EOA is the Bond underwriter. This is the intended demo architecture.

---

## 0. Prerequisites

- **Node.js 20+** and `npm`
- **Foundry** (`forge`) installed for `cork/`
- **Arbitrum One RPC** endpoint (Alchemy, Infura, etc.)
- **Pimlico API key** with Arbitrum One credits
- **Two funded EOAs**:
  - `ZYFAI_SHARED_EOA` — owns the Zyfai Safe; also used to create the market and post the opening bid in the simple path
  - `BOND_EOA` — the Bond underwriting bot
- **CA token** and **REF token** addresses for your pilot pair
  - CA must have `name()`/`symbol()`/`decimals()` (e.g. native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`)
  - REF must be a different ERC-20, non-rebasing, ≤18 decimals, with `name()`/`symbol()`
- Live addresses are in `.claude/skills/cork-operations/references/addresses.md`

---

## 1. Build the Cork package

```bash
cd cork
git submodule update --init --recursive
forge build
```

If you get `Permission denied (publickey)` during submodule update, the nested Phoenix submodule is using an SSH URL. Tell Git to use HTTPS for GitHub SSH URLs:

```bash
git config --global url."https://github.com/".insteadOf "git@github.com:"
git submodule update --init --recursive
```

If `forge build` later complains that `BokkyPooBahsDateTimeLibrary` or `permit2` sources are missing, force-checkout those two submodules:

```bash
cd cork/lib/phoenix
git submodule update --init --recursive --force \
  lib/BokkyPooBahsDateTimeLibrary \
  lib/permit2
```

Install viem in the examples folder (used to create the market and opening bid):

```bash
cd cork/docs/examples
npm install
```

---

## 2. Start the Zyfai server

```bash
cd zyfai
npm install
cp .env.example .env
# Edit .env and fill:
#   SHARED_EOA_PRIVATE_KEY  (the ZYFAI_SHARED_EOA)
#   PIMLICO_API_KEY
#   ALCHEMY_RPC_URL
npm run dev
```

Get the deterministic Safe address:

```bash
curl http://localhost:3000/wallet
```

Output:

```json
{
  "smartWalletAddress": "0x...",
  "ownerAddress": "0x...",
  "isDeployed": false
}
```

**Fund the Safe** with the CA token (e.g. USDC). Gas is sponsored by Pimlico, but the wallet must hold the premium currency.

Optional health check:

```bash
curl http://localhost:3000/health
```

---

## 3. Create the market and post the opening bid

We use `cork/docs/examples/market-rfq.mjs`. It does two things:

1. Calls `CorkMarketCreator.createMarket` — this is the on-chain RFQ.
2. Posts a BUY bid on the Cork order book.

### 3.1 Set the example environment

```bash
cd cork/docs/examples
export PRIVATE_KEY=0x...                    # ZYFAI_SHARED_EOA
export RPC_URL=https://arb-mainnet.g.alchemy.com/v2/...
export ORDERBOOK_URL=https://api-phoenix.cork.tech
export MARKET_CREATOR=0x4B5B91cF4d1DAdb7439beB68926c86D2D8C68dBC
export CA=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
export CA_DECIMALS=6
export REF=0x...                            # your reference asset
export RATE=0.8                             # 1 REF in CA
export MARKET_LIFETIME_SECONDS=86400        # 24h
export SIZE_CST=1000000000000000000         # 1 cST (18 decimals)
export PRICE_CA_PER_CST=0.006               # premium per cST in CA units
export EXPIRY_SECONDS=600                   # bid lifetime
export SWAP_FEE_PCT=1
export UNWIND_FEE_PCT=2
export PREMIUM_DISPLAY=60
```

### 3.2 Approve CA to the 1inch Limit Order Protocol

The bid maker offers CA as premium. The 1inch protocol must be allowed to pull it at fill time.

Using `cast`:

```bash
cast send $CA "approve(address,uint256)" \
  0x111111125421cA6dc452d289314280a0f8842A65 \
  1000000000000000000 \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY
```

Or use any wallet.

### 3.3 Run the market-creation + bid script

```bash
cd cork/docs/examples
npx tsx market-rfq.mjs
```

Expected output:

```
market created — poolId: 0x... oracle: 0x... cST: 0x...
201 { orderHash: '0x...' }
```

**Save the `poolId` and `orderHash`.**

> If the POST returns `400 "no matching pool found"`, the API indexer has not seen the new pool yet. Use `post-opening-bid.mjs` (see below) instead of re-running `market-rfq.mjs` — re-running `createMarket` with the same rate will revert because the fixed-rate oracle factory uses CREATE2 per rate.

### 3.4 If the bid POST failed with "no matching pool found"

The market is already on-chain. Just post the bid with the retry script:

```bash
export POOL_ID=0x...      # from the market-rfq.mjs output
export CST=0x...          # cST address from the output
# other env vars same as above
npx tsx post-opening-bid.mjs
```

It retries every 5 seconds for 60 seconds until the indexer catches up.

### 3.4 Important note for the Bond side

Because the opening bid was posted by an **EOA** (the Zyfai shared EOA), set Bond's `DEMAND_MAKER_ADDRESS` environment variable to **that EOA address**, not the Safe address, for this MVP demo.

---

## 4. Run the Bond underwriting agent

```bash
cd bond
npm install
# .env exists from .env.example; edit it and fill real values
npm run dev
```

Required values in `bond/.env`:

```bash
RPC_URL=https://arb-mainnet.g.alchemy.com/v2/...
CORK_API_URL=https://api-phoenix.cork.tech
BOND_EOA_PRIVATE_KEY=0x...                  # the BOND_EOA

CA_TOKEN=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
CA_DECIMALS=6
REF_TOKEN=0x...                             # same REF as above
DEMAND_MAKER_ADDRESS=0x...                    # the EOA that posted the bid (MVP path)

FLOOR_PREMIUM_BPS=50
COUNTER_MARGIN_BPS=10
MAX_CA_POSITION=1000000000                  # max CA locked, in atomic units
ORDER_LIFETIME_SECONDS=600
```

Make sure the **Bond EOA** is funded with:

- **ETH** for gas
- **CA tokens** to back the JIT mint

The agent will:

1. Poll `GET /v1/pools` for the market.
2. Poll `GET /v1/limit-orders/orderbook` for the BUY bid.
3. Price the bid.
4. If `bid premium >= FLOOR_PREMIUM_BPS`, lift it taker-side via the JIT adapter.
5. Otherwise, post a counter SELL ask at `FLOOR + COUNTER_MARGIN`.

You should see logs like:

```
evaluating bid
  premiumBps: 60
  floorBps: 50
  action: LIFT_BID
lifted CONTRACT bid
  txHash: 0x...
```

or, if below floor:

```
posted counter SELL ask
  orderHash: 0x...
  premiumBps: 60
```

---

## 5. Verify the trade

### 5.1 Via the Cork API

```bash
curl "https://api-phoenix.cork.tech/v1/limit-orders/fills?chainId=42161&poolId=0x..."
```

You should see the fill with `maker`, `taker`, `makingAmount`, and `takingAmount`.

### 5.2 On-chain

Look up the transaction on an Arbitrum block explorer. The fill calls `fillOrderArgs` or `fillContractOrderArgs` on:

```
0x111111125421cA6dc452d289314280a0f8842A65
```

### 5.3 Token balances

- **Zyfai Safe** should now hold `cST` (cover).
- **Bond EOA** should now hold `cPT` (principal / underwriting claim) plus the premium CA.

---

## 6. Post-expiry / unwind

- **Before expiry**: if the covered position depegs, Zyfai can exercise `cST + REF → CA` through the Cork adapter.
- **After expiry**: the Bond agent automatically redeems its `cPT` for the remaining pool assets.

---

## 7. Production path — Zyfai Safe as the bid maker

In this path the demand-side bid is posted by the **Zyfai Safe** (a contract/ERC-1271 maker), and Bond uses a **separate EOA**.

### 7.1 Generate a separate Bond EOA

```bash
cast wallet new
```

Save the private key. Send ETH and CA (e.g. 5 USDC) to the printed address.

### 7.2 Update `bond/.env`

```bash
BOND_EOA_PRIVATE_KEY=0x...              # the new Bond EOA
DEMAND_MAKER_ADDRESS=0x069Aa4242E08A9A694E52428d27182D5905BB05c   # Zyfai Safe
```

### 7.3 Approve CA from the Safe to the 1inch LOP

The Safe must allow the 1inch protocol to pull the premium CA. Use the Zyfai `/tx` endpoint.

In `zyfai/`:

```bash
npx tsx scripts/encode-approve.ts 0x111111125421cA6dc452d289314280a0f8842A65 1
```

Copy the curl and run it against `http://localhost:3000/tx`.

### 7.4 Post the opening BUY bid from the Safe

```bash
cd cork/docs/examples

export PRIVATE_KEY=0x...                  # Zyfai shared EOA (Safe owner)
export RPC_URL=https://arb-mainnet.g.alchemy.com/v2/...
export ORDERBOOK_URL=https://api-phoenix.cork.tech
export SAFE_ADDRESS=0x069Aa4242E08A9A694E52428d27182D5905BB05c
export CA=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
export CA_DECIMALS=6
export CST=0x...                          # pool's cST address
export POOL_ID=0x...                      # the market you already created
export SIZE_CST=1000000000000000000
export PRICE_CA_PER_CST=0.006
export EXPIRY_SECONDS=600
export PREMIUM_DISPLAY=60

npx tsx post-safe-bid.mjs
```

The script:
- builds the EIP-712 order with `maker = SAFE_ADDRESS`,
- wraps the order hash in a Safe `SafeMessage(bytes)` envelope,
- signs the SafeMessage hash with the owner key,
- verifies `isValidSignature` locally,
- POSTs to the Cork API with `makerAccountType: "CONTRACT"`.

### 7.5 Run Bond

```bash
cd bond
npm run dev
```

Bond will discover the Safe's bid, see `makerAccountType: "CONTRACT"`, and call `fillContractOrderArgs` with the raw signature bytes and the JIT adapter interaction.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `createMarket` reverts with no error data | Either the rate was already used (CREATE2 collision) or the REF token lacks `name()`/`symbol()`. Pick a new rate or a valid REF token. |
| Bond never sees the bid | Check that `DEMAND_MAKER_ADDRESS` in `bond/.env` equals the address that posted the bid (EOA or Safe). Check the bid status is `OPEN` or `PARTIALLY_FILLED`. |
| `MintUnavailable` on fill | The market was created with `isWhitelistEnabled=true`. Re-create with `isWhitelistEnabled=false`. |
| `BadSignature` on fill | Wrong `makerAccountType` branch. If the bid maker is an EOA, Bond must use `fillOrderArgs`. If it is a Safe/contract, use `fillContractOrderArgs`. |
| Bond skips with "insufficient CA balance" | Fund the Bond EOA with enough CA to cover the JIT mint cost. |
| `OrderExpired` | The bid/ask expired. Re-run `market-rfq.mjs`/`post-safe-bid.mjs` or let Bond post a new counter. |
| Safe signature rejected by API | Make sure `post-safe-bid.mjs` signed `SafeMessage(orderHash)`, not the raw order hash, and that the Safe owner key is correct. |

---

## Quick command cheat-sheet

```bash
# Zyfai
cd zyfai && npm run dev

# Market + bid
cd cork/docs/examples && npx tsx market-rfq.mjs

# Bond
cd bond && npm run dev

# API health / wallet
curl http://localhost:3000/health
curl http://localhost:3000/wallet

# Check fills
curl "https://api-phoenix.cork.tech/v1/limit-orders/fills?chainId=42161&poolId=<POOL_ID>"
```
