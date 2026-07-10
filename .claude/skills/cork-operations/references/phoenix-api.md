# Cork Phoenix API — read surfaces

<!-- Source of truth: live OpenAPI spec at https://api-phoenix.cork.tech/docs/json.
     Base URL also stated in references/addresses.md. -->

Live base URL: **`https://api-phoenix.cork.tech`** — all endpoints under `/v1`; interactive
API docs at **`https://api-phoenix.cork.tech/docs`**. This is the value for the scripts'
`ORDERBOOK_URL` / `CORK_API_URL` environment variables (`references/limit-orders.md`).

Conventions (all endpoints): no authentication; GET with query filters; cursor pagination —
every list response is `{ items, nextCursor, hasMore }`, pass `nextCursor` back to continue;
`limit` max 2000 (orderbook/markets/fills default 100, pools/flows default 2000); wei values
travel as strings; timestamps unix seconds. Errors: `{ error, message, details }` with a 4xx
status.

**Arbitrum filtering:** always filter with the numeric `chainId=42161` — the `chainName` enum
still reads `mainnet | virtual | sepolia` and does not name Arbitrum. **Local-fork caveat:**
the live API cannot see a local anvil fork's state; on a bare fork fall back to direct viem
reads — pool state via the `CorkPoolManager` views (`references/pool-actions.md`), positions
via token `balanceOf`, and the file-handoff order flow (`references/limit-orders.md`).

**Fee-name mapping** (stated once, here): on-chain `swapFee` ↔ API `exerciseFeePercentage`;
on-chain `unwindSwapFee` ↔ API `repurchaseFeePercentage`. Same values, different vocabulary.

## GET /v1/pools/

All Cork pools with config and live state. Key filters: `chainId`, `poolId`,
`collateralAddress`, `referenceAddress`, `swapAddress`, `poolWhitelistStatus`
(`enabled|disabled`), `expiryBefore`/`expiryAfter`, `fromTimestamp`/`toTimestamp`.
Item shape (the fields that matter): `poolId`, `expiry`, `collateralToken`, `referenceToken`,
`principalToken` (cPT), `swapToken` (cST), `rateOracleAddress`, `isWhitelistEnabled`, the five
pause flags (`isDepositPaused`, `isSwapPaused`, `isWithdrawPaused`, `isUnwindSwapPaused`,
`isUnwindDepositPaused`), `exerciseFeePercentage`, `repurchaseFeePercentage`, `tvl`,
`collateralValue`, `referenceValue`. Ceremony use: this is where a fresh market appears —
the indexer tails the chain and registers it within seconds; on "no matching pool found",
retry with backoff, NEVER re-create.

## GET /v1/pools/whitelisted-addresses

Whitelist state per pool. Key filters: `chainId`, `poolId`, `walletAddress`,
`poolWhitelistStatus`. Item: `poolId`, `isWhitelistEnabled`, `whitelistedAddresses[]`,
`previouslyWhitelistedAddresses[]`. Use to pre-check pool-action eligibility on whitelisted
markets (JIT markets must have the whitelist off anyway).

## GET /v1/flows/

Per-wallet action history across pools. Key filters: `chainId`, `walletAddress`, `poolId`,
`actionType` (`exercise | repurchase | redeem | mint | unwind`), block/timestamp ranges.
Item: `poolId`, `txHash`, `blockTimestamp`, `walletAddress`, `actionType`, and the four
deltas — `deltaCollateral`, `deltaReference`, `deltaPrincipal`, `deltaSwap` (signed, as
strings). Use to reconstruct your own (or a counterparty's) position history.

## GET /v1/limit-orders/markets

Which (makerAsset, takerAsset) pairs have order flow. Filters: `chainId`, `poolId`,
`makerAsset`, `takerAsset`, `onlyActive`. Item: `chainId`, `poolId`, `makerAsset`,
`takerAsset`, `isActive`.

## GET /v1/limit-orders/orderbook

The resting book — the ceremony's discovery surface. Filters: `chainId`, `poolId`, `maker`,
`side` (`BUY|SELL`), `status` (repeatable: `OPEN | PARTIALLY_FILLED | FILLED | CANCELLED |
EXPIRED` — query open interest with `status=OPEN&status=PARTIALLY_FILLED`). Item: the full
signed order (`salt`, `maker`, `receiver`, `makerAsset`, `takerAsset`, `makingAmount`,
`takingAmount`, `makerTraits`), plus `orderHash`, `signature`, `makerAccountType`
(`EOA|CONTRACT` — branch your fill on THIS field), `extension` (verbatim bytes for the fill
args), `side`, `premium`, `expiry`, `nonce`, `status`, `remainingMakingAmount`,
`remainingTakingAmount`. Everything needed to fill is in the item; verify on-chain before
trusting it (trust rule in `references/limit-orders.md`).

## GET /v1/limit-orders/fills

Executed fills (the indexer flips order status from these events, within seconds). Filters:
`chainId`, `poolId`, `orderHash`, `maker`, `taker`, block/timestamp ranges. Item: `orderHash`,
`txHash`, `blockTimestamp`, `maker`, `taker`, `makingAmount`, `takingAmount`, `isPartialFill`.
Use to confirm settlement after filling and to track counterparties' realized flow.

## POST /v1/limit-orders

The one write surface — full payload, validation behavior, and Cork metadata are covered in
`references/limit-orders.md` (Submission section). 201 → `{orderHash}`.
