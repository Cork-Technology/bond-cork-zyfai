import { type Hex } from 'viem';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { OrderItem, PoolItem } from './cork.js';
import { liftBid, signAndPostCounterAsk, type CounterAskInputs } from './orders.js';
import { ensureApproval, getBalance, isMarketFillable, previewMint } from './adapter.js';
import { book, remainingCaCapacity } from './position.js';

export async function executeLift(
  pool: PoolItem,
  bid: OrderItem,
): Promise<{ kind: 'lifted'; txHash: Hex } | { kind: 'skipped'; reason: string }> {
  const fillability = await isMarketFillable(pool.poolId, pool.isWhitelistEnabled);
  if (!fillability.ok) {
    return { kind: 'skipped', reason: fillability.reason ?? 'market not fillable' };
  }

  const sizeCst = BigInt(bid.remainingTakingAmount);
  if (sizeCst === 0n) {
    return { kind: 'skipped', reason: 'zero remaining taking amount' };
  }

  const caRequired = await previewMint(pool.poolId, sizeCst);
  const caReceive = (BigInt(bid.makingAmount) * sizeCst) / BigInt(bid.takingAmount);
  const netCaAtRisk = caRequired > caReceive ? caRequired - caReceive : 0n;

  if (netCaAtRisk > remainingCaCapacity()) {
    return { kind: 'skipped', reason: 'CA position cap would be exceeded' };
  }

  const caBalance = await getBalance(env.CA_TOKEN);
  if (caBalance < caRequired) {
    return { kind: 'skipped', reason: 'insufficient CA balance for JIT mint' };
  }

  await ensureApproval(env.CA_TOKEN, env.CORK_LIMIT_ORDER_ADAPTER, caRequired);
  await ensureApproval(pool.swapToken.address, env.ONE_INCH_LOP_V4, sizeCst);

  const txHash = await liftBid(bid, pool.poolId, sizeCst);
  book.caAtRiskFromFills += netCaAtRisk;
  return { kind: 'lifted', txHash };
}

export async function executeCounter(
  pool: PoolItem,
  premiumBps: number,
): Promise<{ kind: 'posted'; orderHash: Hex } | { kind: 'skipped'; reason: string }> {
  const fillability = await isMarketFillable(pool.poolId, pool.isWhitelistEnabled);
  if (!fillability.ok) {
    return { kind: 'skipped', reason: fillability.reason ?? 'market not fillable' };
  }

  const capacity = remainingCaCapacity();
  if (capacity === 0n) {
    return { kind: 'skipped', reason: 'CA position cap reached' };
  }

  // Size the ask so the net CA at risk (mint cost minus premium received) fits in
  // the remaining capacity. Start from a floor-premium bound and downsize if the
  // on-chain preview says the collateral required is too high.
  let sizeCst = (capacity * 10000n) / BigInt(Math.max(env.FLOOR_PREMIUM_BPS, 1));
  const MIN_CST_ASK = 1000n; // ~1e-15 cST; avoids dust orders
  let caRequired = 0n;
  let takingAmount = 0n;
  let netAtRisk = 0n;
  while (sizeCst >= MIN_CST_ASK) {
    caRequired = await previewMint(pool.poolId, sizeCst);
    takingAmount = (sizeCst * BigInt(premiumBps)) / 10000n;
    netAtRisk = caRequired > takingAmount ? caRequired - takingAmount : 0n;
    if (netAtRisk <= capacity) break;
    sizeCst = sizeCst / 2n;
  }
  if (sizeCst < MIN_CST_ASK || netAtRisk > capacity) {
    return { kind: 'skipped', reason: 'ask would exceed CA capacity after mint cost' };
  }

  const caBalance = await getBalance(env.CA_TOKEN);
  if (caBalance < caRequired) {
    return { kind: 'skipped', reason: 'insufficient CA balance to back ask' };
  }

  await ensureApproval(env.CA_TOKEN, env.CORK_LIMIT_ORDER_ADAPTER, caRequired);
  await ensureApproval(pool.swapToken.address, env.ONE_INCH_LOP_V4, sizeCst);

  const inputs: CounterAskInputs = {
    poolId: pool.poolId,
    sizeCst,
    premiumBps,
  };
  const res = await signAndPostCounterAsk(pool, inputs);
  book.caLockedInOpenOrders += netAtRisk;
  book.orderHashes.add(res.orderHash);
  return { kind: 'posted', orderHash: res.orderHash };
}
