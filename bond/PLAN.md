# Bond Underwriting Agent — Implementation Plan

This document is the build plan for the `bond/` underwriting agent in the `bond-cork-zyfai` pilot.

Scope: **Track 2 · underwriting agent (supply side)**. The agent answers Zyfai’s on-chain RFQ, prices the risk slice, signs a 1inch LOP v4 limit order, and ends up holding `cPT` (plus the premium) after an atomic fill.

---

## 1. Goal & success criteria

End-to-end behavior:

1. Zyfai creates a Cork market (this is the RFQ) and posts a **BUY** bid for `cST`.
2. The Bond agent discovers the market + bid via the Cork Phoenix API.
3. The Bond agent runs its pricing model and decides: **lift the bid** or **counter with an ask**.
4. The agent signs the appropriate EIP-712 order and either fills taker-side JIT or posts a maker-side JIT ask.
5. After fill, the agent tracks its `cPT` position and can unwind/redeem post-expiry.

Success = a live loop on Arbitrum One: RFQ → signed quote → accept → on-chain fill.

---

## 2. Tech stack

Mirror the `zyfai/` conventions so the two agents are familiar to operate side-by-side:

- **Node.js 20+**, TypeScript strict, ESM.
- **viem** for RPC, contract calls, signing, typed-data hashing.
- **zod** for environment validation.
- **pino** for logging.
- Optional: a tiny **Express** health/quote server on `PORT`.

Reuse the byte plumbing from `cork/docs/examples/lib.mjs` (extension encoding, salt commitment, traits, signatures, fill ABIs). Do not rewrite it.

---

## 3. Environment file

See [`bond/.env.example`](./.env.example). Copy it to `bond/.env` and fill in the private key + RPC URL.

Key variables:

| Variable | Purpose |
|---|---|
| `RPC_URL` | Arbitrum One HTTP RPC |
| `CORK_API_URL` | `https://api-phoenix.cork.tech` |
| `BOND_EOA_PRIVATE_KEY` | Bond bot EOA signer |
| `CORK_*` addresses | Live shadow-Phoenix contracts (already filled) |
| `CA_TOKEN` / `REF_TOKEN` | Collateral and reference asset for the pilot |
| `DEMAND_MAKER_ADDRESS` | Expected counterparty maker on demand-side bids (EOA in the simple MVP path, Safe in the advanced path) |
| `FLOOR_PREMIUM_BPS` / `COUNTER_MARGIN_BPS` | Pricing knobs |
| `MAX_CA_POSITION` / `ORDER_LIFETIME_SECONDS` | Risk / negotiation knobs |

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Bond Underwriting Agent                      │
├─────────────────────────────────────────────────────────────────────┤
│  config/         env.ts  ── zod-validated env                       │
│  services/                                                                  │
│    cork.ts       ── Phoenix API client (pools, orderbook, fills)    │
│    chain.ts      ── viem public + wallet client                     │
│    pricing.ts    ── floor price + quote builder                     │
│    orders.ts     ── sign/build/post 1inch LOP v4 orders             │
│    adapter.ts    ── JIT mint / lift-bid / fill helpers              │
│    position.ts   ── cPT inventory, P&L, expiry tracking             │
│  engine/                                                                        │
│    discovery.ts  ── cron: poll pools + open bids                    │
│    decision.ts   ── lift vs counter logic                           │
│    execution.ts  ── simulate → send → wait for receipt              │
│  app.ts / index.ts                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Core modules

### 5.1 `services/chain.ts`

- Build a **viem wallet client** from `BOND_EOA_PRIVATE_KEY` on Arbitrum.
- Expose `publicClient` for reads and `walletClient` for writes.
- Load ABIs for:
  - `CorkPoolManager` (market, assets, shares, swapRate, pause bitmap, preview/max views)
  - `CorkLimitOrderAdapter` (no state, just revert catalog)
  - `CorkMarketCreator` (for local/fork market creation if needed)
  - ERC-20 (`approve`, `balanceOf`, `allowance`)
  - 1inch LOP v4 (`fillOrderArgs`, `fillContractOrderArgs`, `hashOrder`)

### 5.2 `services/cork.ts`

Thin wrapper around the Cork Phoenix API:

```ts
GET /v1/pools?chainId=42161
GET /v1/pools/whitelisted-addresses?chainId=42161&poolId=...
GET /v1/limit-orders/orderbook?chainId=42161&poolId=...&side=BUY&status=OPEN&status=PARTIALLY_FILLED
GET /v1/limit-orders/fills?chainId=42161&orderHash=...
POST /v1/limit-orders
```

Handle cursor pagination (`nextCursor`, `hasMore`). Use the exact response fields from the OpenAPI spec:

- `poolId`, `collateralToken`, `referenceToken`, `principalToken`, `swapToken`, `isWhitelistEnabled`, pause flags, `exerciseFeePercentage`, `repurchaseFeePercentage`.
- `orderHash`, `signature`, `makerAccountType`, `extension`, `side`, `premium`, `expiry`, `remainingMakingAmount`, `remainingTakingAmount`.

### 5.3 `services/pricing.ts`

Responsible for turning a bid into a decision.

Inputs:

- Pool config (fees, expiry, rate oracle)
- Resting BUY bid (`makingAmount` CA, `takingAmount` cST)
- Agent state (open orders, cPT/cST inventory, capital)

Logic:

```
impliedPremiumBps = makingAmount / takingAmount * 10_000  // cST priced in CA
floor = floorPremiumBps(model risk, tenor)

if impliedPremiumBps >= floor:
  decision = LIFT_BID
else:
  decision = COUNTER
  counterPremiumBps = floor + COUNTER_MARGIN_BPS
```

Start simple: a rules engine with the env knobs. Later, replace with the real bond scoring engine.

### 5.4 `services/orders.ts`

Build and sign 1inch LOP v4 orders. Use `cork/docs/examples/lib.mjs` for all byte plumbing.

**Path A — lift Zyfai’s bid (taker-side JIT):**

- The bid maker is the Safe → `makerAccountType = CONTRACT`.
- Call `fillContractOrderArgs` on 1inch LOP v4.
- Attach the adapter as an unsigned taker interaction:
  ```ts
  const interaction = packTargetAndData(ADAPTER, poolId)
  ```
- Pre-approve:
  - `CA -> CorkLimitOrderAdapter`
  - `cST -> 1inch LOP v4`

**Path B — counter with an ask (maker-side JIT):**

- Maker is the Bond EOA → `makerAccountType = EOA`.
- Build extension with adapter as pre-interaction:
  ```ts
  const extension = buildExtension({
    preInteractionData: packTargetAndData(ADAPTER, poolId),
  })
  const salt = saltForExtension(extension)
  const makerTraits = buildMakerTraits({
    expiry: orderExpiry(ORDER_LIFETIME_SECONDS),
    nonce: nextNonce(),
    hasExtension: true,
    preInteraction: true,
  })
  ```
- Sign EIP-712 via viem `signTypedData(orderTypedData(...))`.
- Cross-check `hashOrder` on-chain before POSTing.
- Post to `POST /v1/limit-orders` with `side: "SELL"`, `premium`, `expiry`, etc.

**Important account-type rule:**

| Maker type | Verification | Fill function | Signature format |
|---|---|---|---|
| `EOA` | ECDSA recovery | `fillOrderArgs` | EIP-2098 compact `r/vs` |
| `CONTRACT` | ERC-1271 `isValidSignature` | `fillContractOrderArgs` | raw 65-byte `r + s + v` |

### 5.5 `services/adapter.ts`

Helpers around the JIT adapter:

- `previewMint(poolId, cstAmount)` → CA required.
- Build taker traits for lifting bids (`extensionHex`, `interactionHex`, threshold).
- Verify allowance/balance before filling.
- Decode reverts with `KNOWN_ERRORS_ABI` from `lib.mjs`.

### 5.6 `services/position.ts`

Track the agent’s book:

- CA balance and approved amounts.
- Open orders (local cache keyed by `orderHash`).
- cPT / cST balances per pool (read via `balanceOf`).
- Post-expiry redemption queue.

Read source of truth from `GET /v1/flows?walletAddress=<bond>` and on-chain balances; local cache is only for fast decisions.

---

## 6. Main loop (`engine/discovery.ts`)

A cron-style loop (e.g. every 30s):

1. **Discover markets**
   - `GET /v1/pools?chainId=42161` filtered to `CA_TOKEN`/`REF_TOKEN` and `isWhitelistEnabled=false`.
   - Skip expired pools (`block.timestamp >= expiry`).
   - Skip pools already processed unless a new bid appears.

2. **Discover bids**
   - For each tracked pool, `GET /v1/limit-orders/orderbook?poolId=...&side=BUY&status=OPEN&status=PARTIALLY_FILLED`.
   - Filter to makers matching `DEMAND_MAKER_ADDRESS` (or any known demand counterparty).

3. **Price & decide**
   - Run `pricing.ts` on each bid.
   - `LIFT_BID` → `execution.ts` fills immediately.
   - `COUNTER` → `orders.ts` posts a SELL ask with the adapter in the signed extension.

4. **Track fills**
   - Poll `GET /v1/limit-orders/fills?maker=<bond>` for posted asks.
   - Update local position state.

5. **Post-expiry housekeeping**
   - For expired pools where the agent holds cPT, call `redeem`/`withdraw`.

---

## 7. Safety rails (hard rules)

Borrowed directly from the `cork-operations` skill:

- **Always simulate before sending** (`simulateContract` or gas estimation with revert decoding).
- **Always call the matching `preview*` / `max*` view first** and bound inputs by it.
- **Check pause bitmap, whitelist flag, and expiry phase** before any action.
- **Size approvals exactly** — approve remaining open orders + new order amount.
- **Counter-offers are new orders, never cancels**; set short expiries on every negotiation order.
- **JIT markets must have `isWhitelistEnabled=false`**; verify it before acting.
- **Cross-check the order hash on-chain** before POSTing to the API.
- **Never use Permit2 for makers** — classic ERC-20 approvals only.
- Cap total CA at risk with `MAX_CA_POSITION`.

---

## 8. File layout

```
bond/
├── .env.example              # environment template
├── .env                      # copy of .env.example (not committed)
├── PLAN.md                   # this file
├── package.json
├── tsconfig.json
├── src/
│   ├── config/
│   │   └── env.ts
│   ├── services/
│   │   ├── chain.ts
│   │   ├── cork.ts
│   │   ├── pricing.ts
│   │   ├── orders.ts
│   │   ├── adapter.ts
│   │   └── position.ts
│   ├── engine/
│   │   ├── discovery.ts
│   │   ├── decision.ts
│   │   └── execution.ts
│   ├── logger.ts
│   ├── app.ts
│   └── index.ts
└── test/
    └── ...
```

---

## 9. Build & run commands

```bash
cd bond
npm install
npm run typecheck
npm run dev          # tsx watch
npm run start        # production build + run
```

Useful manual scripts to add later:

- `scripts/approve-ca.ts` — approve CA to the adapter.
- `scripts/approve-cst.ts` — approve cST to 1inch LOP.
- `scripts/lift-bid.ts` — one-shot lift of a given order hash.
- `scripts/post-ask.ts` — one-shot counter ask.

---

## 10. Testing plan

1. **Local fork** (optional but recommended):
   - Follow `cork/docs/fork-testing.md` Option B.
   - Deploy `cork/script/Deploy.s.sol` locally.
   - Run the `cork/docs/examples/ceremony-e2e.mjs` example against the fork to verify the byte plumbing.

2. **Unit tests**:
   - `pricing.ts` decision matrix.
   - `orders.ts` extension/salt commitment.
   - `cork.ts` API response parsing.

3. **Integration tests**:
   - Lift a live (or fork) Zyfai bid end-to-end.
   - Post a counter ask and verify it appears on `GET /v1/limit-orders/orderbook`.
   - Simulate fills before sending; verify no reverts.

4. **Staging**:
   - `$200` end-to-end test on Arbitrum One shadow Phoenix before demo day.

---

## 11. Milestones

| Milestone | Deliverable |
|---|---|
| M0 | `bond/.env` + `package.json` + viem client boot |
| M1 | API client: list pools + open bids |
| M2 | Pricing engine: floor + lift/counter decision |
| M3 | Path A: lift a Safe bid via JIT adapter (taker-side) |
| M4 | Path B: post a JIT ask as EOA maker + Safe fills it |
| M5 | Position tracking + post-expiry redeem |
| M6 | Live end-to-end demo with Zyfai on Arbitrum One |

---

## 12. References

- `.claude/skills/cork-operations/SKILL.md` — mental model + safety rails.
- `.claude/skills/cork-operations/references/addresses.md` — live address book.
- `.claude/skills/cork-operations/references/limit-orders.md` — the ceremony, JIT orders, signing.
- `.claude/skills/cork-operations/references/market-creation.md` — `CorkMarketCreator.createMarket`.
- `.claude/skills/cork-operations/references/pool-actions.md` — every `CorkPoolManager` call.
- `.claude/skills/cork-operations/references/phoenix-api.md` — API conventions.
- `cork/docs/examples/` — runnable reference scripts (`ceremony-e2e.mjs`, `lift-bid.mjs`, `jit-order.mjs`, `lib.mjs`).
- `cork/src/CorkLimitOrderAdapter.sol` — adapter source.
- [Cork API OpenAPI spec](https://api-phoenix.cork.tech/docs/json).
