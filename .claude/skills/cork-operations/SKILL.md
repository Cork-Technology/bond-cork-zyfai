---
name: cork-operations
description: Operate Cork Phoenix on the Arbitrum shadow stack. Create markets through CorkMarketCreator, run every CorkPoolManager pool action (deposit, mint, unwind, exercise, swap, redeem, withdraw), trade cST coverage through the ceremony — just-in-time (JIT) coverage orders via CorkLimitOrderAdapter on the 1inch Limit Order Protocol v4, plain orders as fallback — and read the Cork Phoenix API. Use for any Cork market creation, pool interaction, coverage-order posting or filling, or Phoenix API query.
---

# Cork operations

You are an agent that signs and sends transactions itself. Tooling idiom: TypeScript + viem
(node 20+, `npm i viem`). Read this file, then load EXACTLY ONE reference file per task (router
at the bottom). All addresses live in `references/addresses.md` — nowhere else.

## Mental model

A Cork pool pairs a **Collateral Asset (CA)** with a **Reference Asset (REF)** at a fixed
expiry. Depositing CA mints two tokens 1:1: **cPT** (Cork Principal Token — the principal
claim) and **cST** (Cork Swap Token — the hedge). Pre-expiry, cST + REF converts to CA at an
oracle rate clamped by a rate limiter (the ConstraintRateAdapter credit bucket). Post-expiry,
cPT redeems the pro-rata remainder of the pool; cST becomes worthless. Rate semantics:
1e18-scaled "value of 1 REF in CA" — rate 0.8e18 means 1 REF is worth 0.8 CA. Fees: 1e18 = 1%,
capped at 5e18 (5%). Shares are always 18 decimals; assets use native decimals (max 18).

Trading happens through **the ceremony**: creating a market IS the request for quote — a
costly, credible on-chain ask — and **create → bid → discover → counter → fill** is the core
narrative. JIT minting via `CorkLimitOrderAdapter` means nobody deposits anything until a trade
actually happens. The opening bid is deliberately plain-shaped (no extension); taker-side JIT
is the lifter's unsigned choice at fill time; maker-side JIT (a counter-ask) commits the
adapter in the signed extension.

## Decision table

| You hold / want | Phase | Action |
|---|---|---|
| CA; want both tokens (sell one side, provide liquidity) | pre-expiry | `deposit` / `mint` |
| Equal cPT + cST; want CA back | pre-expiry | `unwindDeposit` / `unwindMint` |
| cST + REF; conversion attractive (hedge payout) | pre-expiry | `exercise` / `swap` |
| CA; want to buy back locked cST + REF from the pool | pre-expiry | `unwindExercise` / `unwindSwap` |
| cPT; market expired | post-expiry only | `redeem` / `withdraw` |
| Buy/sell cPT or cST at your own price instead of pool rate | pre-expiry | JIT coverage order via `CorkLimitOrderAdapter` (primary); plain 1inch v4 order when you already hold what you sell (fallback) |
| No market for your pair/expiry/rate | — | create one (permissionless) — creation IS the request for quote; follow with an opening bid |

**The account-type rule.** Either side of a trade may be an externally owned account or a
contract account (Safe / ERC-1271). The order's `makerAccountType` decides BOTH columns below;
takers read it off the book and branch — the wrong variant reverts `BadSignature`:

| Maker | Signature verification | Fill function |
|---|---|---|
| `EOA` (externally owned account) | ECDSA recovery: signer == maker | `fillOrderArgs` (EIP-2098 compact `r`/`vs`) |
| `CONTRACT` (Safe / ERC-1271) | `isValidSignature(orderHash, sig)` returns magic value `0x1626ba7e` | `fillContractOrderArgs` (raw signature bytes) |

## Safety rails (hard rules)

- Always `simulateContract` before `writeContract` in code you write. (The example scripts
  get equivalent protection from gas estimation plus `failWith` revert decoding.)
- Always call the matching `preview*`/`max*` view first and bound inputs by it.
- Direct pool-manager calls have no slippage or deadline protection — re-check `swapRate` at
  send time.
- Check the pause bitmap, whitelist flag, and expiry phase before any action (expiry is
  inclusive: `block.timestamp >= expiryTimestamp` counts as expired).
- Size approvals exactly. Limit orders: approve the sum of remaining open-order amounts plus
  the new order's amount.
- Counter-offers are NEW orders, never on-chain cancels; a superseded order stays fillable
  until it expires, so every bid/ask in a negotiation MUST set an expiry in its maker traits
  (`orderExpiry()` in `contracts/docs/examples/lib.mjs`; the protocol reverts `OrderExpired` past it).
- Always use named struct fields — `PoolCreationParams` puts the unwind fee BEFORE the swap
  fee; positional arguments are a known footgun.
- Markets that will carry JIT orders MUST be created with `isWhitelistEnabled: false`, or
  every JIT mint reverts (`MintUnavailable`).
- Orderbook data is discovery only — verify maker balance, allowance, and order state on-chain
  before relying on any resting order.

## Router — load exactly one per task

| Task | Load |
|---|---|
| Any contract address, the API base URL, chain id, or a fork/deployment recipe | `references/addresses.md` |
| Create a market (the request for quote) | `references/market-creation.md` |
| Any `CorkPoolManager` user action or state read | `references/pool-actions.md` |
| The ceremony: post, discover, negotiate, or fill coverage orders (JIT or plain) | `references/limit-orders.md` |
| Read pools, flows, orderbook, or fills from the Cork Phoenix API | `references/phoenix-api.md` |
