# Project — bond.credit × Cork × Zyfai — Agentic Risk-Trading Pilot

> **Context**: Arbitrum Open House London — Founder House, 10–12 July 2026.
> **Goal**: two autonomous agents discover the price of a risk slice and settle it on-chain so a yield agent can allocate where its whitelist gate previously excluded it.

This document explains **what the joint project is**, **what each team is building**, and **where this repo fits**. For the hands-on developer guide, see [`README.md`](./README.md).

---

## The pilot in one paragraph

A **Zyfai demand agent** finds a stablecoin yield opportunity that its risk gate would normally exclude (e.g. a Morpho vault outside its whitelist). It sends an **RFQ** for tail cover on that specific position. The **bond.credit keeper agent** prices the slice from its underwriting engine and returns a **signed EIP-712 limit order** to Cork's off-chain order book. Zyfai fetches the quote, accepts if the unlocked yield exceeds the premium, and settlement executes **atomically on Arbitrum One via 1inch Limit Order Protocol v4**. The cover is a **Cork cST swap token** (short expiry, rolled every cycle); the underwriter earns baseline stablecoin yield while parked plus upfront premium on each fill.

**Success** = one full autonomous cycle (RFQ → signed quote → accept → on-chain settlement) demonstrated live before Sunday judging, on a live Arbitrum Phoenix market, with real capital staged.

---

## Architecture (high level)

```
                Off-chain                                         Arbitrum One
┌──────────────────────────────────┐              ┌──────────────────────────────────────┐
│                                  │              │                                      │
│  Zyfai demand agent              │              │  Zyfai Safe smart account (this repo)│
│  (yield scan + risk gate)        │  ─┐          │  owned by shared EOA, Pimlico paymaster
│                                  │   │          │                                      │
│           │ 1. RFQ               │   │          │  1inch Limit Order Protocol v4       │
│           ▼                      │   │          │  (atomic settlement)                 │
│  bond.credit keeper agent        │   │          │                                      │
│  (underwriting engine)           │   │          │  Cork CorkAdapter                    │
│                                  │   │          │  Cork Pool (CA / REF, cPT / cST)     │
│           │ 2. signed quote      │   │          │                                      │
│           ▼                      │   │          │  Fixed-value rate oracle             │
│  Cork Phoenix order book         │   │          │                                      │
│  (REST API + indexer)            │◄──┘          │                                      │
│                                  │              │                                      │
│           │ 3. Zyfai fetches +   │              │                                      │
│           │    accepts quote     │              │                                      │
│           ▼                      │              │                                      │
│                       ────── 4. fill order on-chain ──────►                            │
│                       ────── 5. if depeg, exercise ──────►                             │
│                                                              │                        │
└──────────────────────────────────┘              └──────────────────────────────────────┘
```

**RFQ loop**: (1) Zyfai identifies a position with an unacceptable tail and requests a quote (asset, size, tenor). (2) Bond prices it and posts a signed EIP-712 order to Cork's book. (3) Zyfai reads the quote and accepts. (4) Settlement executes atomically through 1inch LOP v4: cST goes to Zyfai, premium goes to bond. (5) If a depeg happens during the cover window, Zyfai exercises REF + cST → CA through the CorkAdapter.

**Cork mechanics**: a Phoenix market is defined by a Collateral Asset (CA), a Reference Asset (REF), an expiry, and a rate oracle. Depositing 1 CA mints `1 cPT + 1 cST`. The `cST` is the cover (exercisable at any time before expiry: REF + cST → CA at the oracle rate minus a swap fee). The `cPT` is the underwriting side (redeems the residual pool after expiry, earns collateral yield + premium + fees, bears impairment first). The traded price of `cST` is the discovered price of the risk.

---

## Team split

| Team           | Owns                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Zyfai (us)** | Smart wallet on Arbitrum (this repo), shared EOA, Pimlico paymaster, generic tx API. Demand-side integration on top of this. |
| **bond.credit** | Keeper underwriting agent: RFQ answering, scoring, floor pricing, signed-quote generation. Underwriting-side capital.       |
| **Cork**       | Phoenix core, CorkAdapter, market creation, order-book REST API + indexer, convenience contracts + threat-model note.        |
| **Arbitrum**   | Chain + event; flagship agentic-finance showcase.                                                                            |

**This repo (Zyfai) provides**:

- A deterministic, deployable smart wallet address on Arbitrum One (share it with bond & Cork so they can whitelist it)
- A generic `POST /tx` endpoint so bond's keeper and Cork's tooling can send any userOp on behalf of the Zyfai agent (approve, fill 1inch LOP order, exercise cST, etc.) — sponsored by Pimlico, no ETH needed
- A `GET /wallet` endpoint returning the smart wallet address and its deployment status

**This repo does NOT contain**:

- RFQ / quote logic (bond side)
- Order-book interaction / market creation (Cork side)
- Yield scanning or risk gate (higher-level Zyfai orchestration, on top of this)

The intent is: **provide clean primitives; let bond and Cork build their business logic on top with zero coupling to Zyfai-specific code paths.**

---

## Chain, contracts, and integration surface

- **Chain**: Arbitrum One (chainId `42161`)
- **Smart account**: Safe v1.4.1, ERC-4337 EntryPoint v0.7
- **Bundler + paymaster**: Pimlico
- **Settlement rail**: 1inch Limit Order Protocol v4 (audited)
- **Cork writes**: `CorkAdapter` at `0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407` (same address on all chains), invoked via Morpho Bundler3
  - `safeDeposit` (underwriter mints cPT + cST from CA)
  - `safeExercise` / `safeExerciseOther` / `safeSwap` (cover holder exercises)
  - `safeUnwindDeposit` / `safeRedeem` (exits)
- **Cork reads**: `CorkPoolManager` (`previewAdjustedRate`, `swapFee`; fee encoding `1e18 = 1%`)
- **Cork REST**: `GET /v1/pools`, `POST /v1/limit-orders/`, `GET /v1/limit-orders/markets|orderbook|fills`

Cork ships additional convenience contracts specifically for this pilot; the exact EIP-712 `verifyingContract` the keeper signs against arrives with Cork's Friday docs.

---

## What "success" looks like on Sunday

- Zyfai smart wallet deployed on Arbitrum One, whitelisted on Cork
- bond keeper live, answering RFQs against a pre-underwritten menu (3–4 Morpho stablecoin pools)
- One RFQ → signed quote → accept → fill demonstrated live in a five-minute demo
- Real capital staged: a `$200` end-to-end test before Friday, then a five-figure demo-day deployment (sized after Cork's threat-model note)
- Co-marketing assets ready for the four-way announcement (Arbitrum × Cork × Zyfai × bond.credit)

---

## Post-hackathon (Q3 pilot, end of July / early August)

- Two-vault matched structure (underwriter vault + allocator vault, 1:1 matching cap)
- Second market: agent-vault impairment cover (REF = the Zyfai vault position token)
- Pricing v2 informed by bond's nine months of live agent-performance data + vaults.fyi bootstrap
- Target: six-to-seven-figure LP capital on both sides
