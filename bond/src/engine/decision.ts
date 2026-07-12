import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { OrderItem, PoolItem } from '../services/cork.js';
import { decide, impliedPremiumBps } from '../services/pricing.js';
import { executeCounter, executeLift } from '../services/execution.js';
import type { Hex } from 'viem';

export interface DecisionResult {
  poolId: Hex;
  orderHash: Hex;
  action: 'LIFT_BID' | 'COUNTER' | 'SKIP';
  reason?: string;
  txHash?: Hex;
  postedOrderHash?: Hex;
}

export async function evaluateBid(pool: PoolItem, bid: OrderItem): Promise<DecisionResult> {
  const premium = impliedPremiumBps(BigInt(bid.makingAmount), BigInt(bid.takingAmount));
  logger.info(
    {
      poolId: pool.poolId,
      orderHash: bid.orderHash,
      premiumBps: premium,
      floorBps: env.FLOOR_PREMIUM_BPS,
      remainingTakingAmount: bid.remainingTakingAmount,
    },
    'evaluating bid',
  );

  const decision = decide(BigInt(bid.makingAmount), BigInt(bid.takingAmount));

  if (decision.kind === 'LIFT_BID') {
    const result = await executeLift(pool, bid);
    if (result.kind === 'skipped') {
      logger.warn({ orderHash: bid.orderHash, reason: result.reason }, 'skipped lifting bid');
      return { poolId: pool.poolId, orderHash: bid.orderHash, action: 'SKIP', reason: result.reason };
    }
    return {
      poolId: pool.poolId,
      orderHash: bid.orderHash,
      action: 'LIFT_BID',
      txHash: result.txHash,
    };
  }

  const counter = await executeCounter(pool, decision.premiumBps);
  if (counter.kind === 'skipped') {
    logger.warn({ orderHash: bid.orderHash, reason: counter.reason }, 'skipped counter ask');
    return { poolId: pool.poolId, orderHash: bid.orderHash, action: 'SKIP', reason: counter.reason };
  }
  return {
    poolId: pool.poolId,
    orderHash: bid.orderHash,
    action: 'COUNTER',
    postedOrderHash: counter.orderHash,
  };
}
