# Pool actions — every `CorkPoolManager` user call

<!-- Sources of truth: phoenix-private contracts/interfaces/IPoolManager.sol natspec (v1.1.2,
     commit 0c22c5d3) + the phoenix README. Address: references/addresses.md. -->

All calls take the `poolId` (`MarketId`, a bytes32) from the `MarketCreated` event. Shares
(cPT/cST) are always 18 decimals; asset amounts use native token decimals. Every action has a
`preview*` twin (same math, view) and a `max*` bound — call them first, and simulate before
sending.

## Reading market state

```ts
const PM_ABI = parseAbi([
  "function market(bytes32 poolId) view returns ((address collateralAsset, address referenceAsset, uint256 expiryTimestamp, uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax, address rateOracle))",
  "function assets(bytes32 poolId) view returns (uint256 collateralAssets, uint256 referenceAssets)",
  "function shares(bytes32 poolId) view returns (address principalToken, address swapToken)", // (cPT, cST)
  "function swapRate(bytes32 poolId) view returns (uint256 rate)",   // 1e18-scaled, 1 REF in CA
  "function getPausedBitMap(bytes32 poolId) view returns (uint16)",
  "function swapFee(bytes32 poolId) view returns (uint256)",         // 1e18 = 1%
  "function unwindSwapFee(bytes32 poolId) view returns (uint256)",
]);
```

Pause bitmap bits (1 = paused): **bit 0** deposit (blocks deposit/mint — and JIT), **bit 1**
swap (blocks exercise/swap), **bit 2** withdrawal (blocks redeem/withdraw), **bit 3**
unwind-deposit (blocks unwindDeposit/unwindMint), **bit 4** unwind-swap (blocks
unwindExercise/unwindSwap).

Expiry rules: `block.timestamp >= expiryTimestamp` counts as expired (inclusive). Pre-expiry
actions revert once expired; `redeem`/`withdraw`/`withdrawOther` revert until expired. The
FIRST post-expiry redemption archives the pool balances (liquidity separation); later
redemptions draw from the archive. Exercise/swap math: `collateralOut = referenceIn × rate`
and `cstIn = referenceIn × rate` (per 1e18) — e.g. at rate 0.8e18, exercising 1 REF + 0.8 cST
yields 0.8 CA, minus the swap fee.

## Writing — the one template

Every write below follows this shape (vary function name and args):

```ts
const { request, result } = await client.simulateContract({
  address: POOL_MANAGER, abi: PM_ABI, functionName: "deposit",
  args: [poolId, amount, receiver], account,
});
await client.waitForTransactionReceipt({ hash: await client.writeContract(request) });
```

`result` is the return value (e.g. shares minted) — check it against the preview. Approvals
below are ERC-20 approvals TO the pool manager, sized to the preview result.

## Deposit side (pre-expiry; pause bit 0; economic role: provide liquidity / obtain both legs)

| | signature | preview / max | rounding |
|---|---|---|---|
| exact assets in | `deposit(poolId, collateralAssetsIn, receiver) returns (uint256 cptAndCstSharesOut)` | `previewDeposit` / `maxDeposit(poolId, owner)` | floors shares |
| exact shares out | `mint(poolId, cptAndCstSharesOut, receiver) returns (uint256 collateralAssetsIn)` | `previewMint` / `maxMint` | ceils collateral |

Locks CA; mints equal cPT + cST (18 decimals) to `receiver`. Needs CA approval. Reverts: zero
amount, uninitialized market, paused, expired. Previews return 0 when paused or expired —
treat a 0 preview as "action unavailable".

## Unwind deposit (pre-expiry; pause bit 3; exit a balanced cPT+cST position back to CA)

| | signature | preview / max | rounding |
|---|---|---|---|
| exact assets out | `unwindDeposit(poolId, collateralAssetsOut, owner, receiver) returns (uint256 cptAndCstSharesIn)` | `previewUnwindDeposit` / `maxUnwindDeposit(poolId, owner)` | floor conversion; reverts below a minimum-shares threshold for low-decimal CA |
| exact shares in | `unwindMint(poolId, cptAndCstSharesIn, owner, receiver) returns (uint256 collateralAssetsOut)` | `previewUnwindMint` / `maxUnwindMint` | floors collateral |

Burns EQUAL cPT + cST from `owner`, pays CA to `receiver`. `maxUnwindDeposit`/`maxUnwindMint`
use the minimum of the owner's two share balances. When `msg.sender != owner` the burn uses
the share tokens' allowance — approve cPT AND cST to the pool manager in that case.

## Exercise / swap (pre-expiry; pause bit 1; the hedge payout: hand in cST + REF, take CA at the clamped oracle rate)

| | signature | preview / max |
|---|---|---|
| exact cST in | `exercise(poolId, cstSharesIn, receiver) returns (uint256 collateralAssetsOut, uint256 referenceAssetsIn, uint256 fee)` | `previewExercise` / `maxExercise(poolId, owner)` |
| exact REF in | `exerciseOther(poolId, referenceAssetsIn, receiver) returns (uint256 collateralAssetsOut, uint256 cstSharesIn, uint256 fee)` | `previewExerciseOther` / `maxExerciseOther` |
| exact CA out | `swap(poolId, collateralAssetsOut, receiver) returns (uint256 cstSharesIn, uint256 referenceAssetsIn, uint256 fee)` | `previewSwap` / `maxSwap(poolId, owner)` |

The caller pays BOTH legs: cST shares and REF are LOCKED in the pool (not burned) and become
liquidity recoverable via the unwind actions; approve cST AND REF to the pool manager. Fee is
charged in CA at `swapFee` and sent to the treasury. Reverts: zero amount, paused, expired,
insufficient cST or REF balance, rate-constraint violation (the ConstraintRateAdapter credit
bucket ran dry — `maxExercise`/`maxSwap` already factor it in), insufficient pool liquidity
(swap). No slippage protection: re-check `swapRate(poolId)` right before sending.

## Unwind exercise / unwind swap (pre-expiry; pause bit 4; the reverse: pay CA, buy back locked cST + REF)

| | signature | preview / max |
|---|---|---|
| exact cST out | `unwindExercise(poolId, cstSharesOut, receiver) returns (uint256 collateralAssetsIn, uint256 referenceAssetsOut, uint256 fee)` | `previewUnwindExercise` / `maxUnwindExercise` |
| exact REF out | `unwindExerciseOther(poolId, referenceAssetsOut, receiver) returns (uint256 collateralAssetsIn, uint256 cstSharesOut, uint256 fee)` | `previewUnwindExerciseOther` / `maxUnwindExerciseOther` |
| exact CA in | `unwindSwap(poolId, collateralAssetsIn, receiver) returns (uint256 cstSharesOut, uint256 referenceAssetsOut, uint256 fee)` | `previewUnwindSwap` / `maxUnwindSwap` |

Deposits CA (approve CA), unlocks previously locked cST + REF to `receiver`. Fee at
`unwindSwapFee`. Only possible up to the pool's LOCKED positions: **`maxUnwindExercise` and
`maxUnwindSwap` ignore the caller's balance entirely** — they report the pool's available
locked positions assuming infinite collateral, so bound by your own CA balance too. Reverts:
zero amount, paused, not enough locked positions.

## Redeem / withdraw (POST-expiry only; pause bit 2; the principal claim)

| | signature | preview / max |
|---|---|---|
| exact cPT in | `redeem(poolId, cptSharesIn, owner, receiver) returns (uint256 referenceAssetsOut, uint256 collateralAssetsOut)` | `previewRedeem` / `maxRedeem(poolId, owner)` |
| exact CA out | `withdraw(poolId, collateralAssetsOut, owner, receiver) returns (uint256 cptSharesIn, uint256 actualCollateralAssetsOut, uint256 actualReferenceAssetsOut)` | `previewWithdraw` / `maxWithdraw` |
| exact REF out | `withdrawOther(poolId, referenceAssetsOut, owner, receiver) returns (uint256 cptSharesIn, uint256 actualCollateralAssetsOut, uint256 actualReferenceAssetsOut)` | `previewWithdrawOther` / `maxWithdrawOther` |

Burns cPT from `owner` for a pro-rata slice of BOTH remaining asset pools (cST is worthless
now and is not involved). All three revert before expiry; the first successful redemption
archives the pool balances. `redeem` reverts below a minimum-shares threshold for low-decimal
assets. When `msg.sender != owner`, the cPT burn uses the token allowance — `owner` must have
approved cPT to the pool manager. `maxRedeem` is simply the owner's cPT balance once expired.

## Revert quick-reference

| Symptom | Cause / fix |
|---|---|
| `InvalidAmount()` / `InvalidParams()` | zero amount input |
| preview returns 0 (or zeros) | action paused or wrong expiry phase — check `getPausedBitMap` and `market().expiryTimestamp` |
| `InsufficientSharesAmount(min, got)` | below the minimum-shares threshold (low-decimal assets) — redeem/unwindDeposit with at least `min` |
| ERC-20 transfer/allowance revert | missing approval to the pool manager (see each block's approval note) |
| rate-constraint revert on exercise/swap | credit bucket exhausted — retry smaller (bound by `maxExercise`/`maxSwap`) or later |
| whitelist revert | market created with `isWhitelistEnabled: true` and caller not whitelisted |
