import { type Hex } from 'viem';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { listOrderbookBids, listPools, poolExpiryToSeconds, type PoolItem, type OrderItem } from '../services/cork.js';
import { refreshPosition, redeemPostExpiry, book } from '../services/position.js';
import { evaluateBid, type DecisionResult } from './decision.js';

const seenOrderHashes = new Set<Hex>();

export const recentDecisions: DecisionResult[] = [];
const MAX_RECENT_DECISIONS = 50;

function matchesPilot(pool: PoolItem): boolean {
  return (
    pool.collateralToken.address.toLowerCase() === env.CA_TOKEN.toLowerCase() &&
    pool.referenceToken.address.toLowerCase() === env.REF_TOKEN.toLowerCase() &&
    pool.isWhitelistEnabled === false
  );
}

function isExpired(pool: PoolItem, nowSeconds: number): boolean {
  return nowSeconds >= poolExpiryToSeconds(pool);
}

async function discoverEligiblePools(nowSeconds: number): Promise<PoolItem[]> {
  const pools = await listPools();
  return pools.filter((pool) => {
    if (!matchesPilot(pool)) return false;
    if (isExpired(pool, nowSeconds)) {
      logger.debug({ poolId: pool.poolId }, 'skipping expired pool');
      return false;
    }
    return true;
  });
}

async function discoverDemandBids(pool: PoolItem): Promise<OrderItem[]> {
  const bids = await listOrderbookBids(pool.poolId);
  const makerLower = env.DEMAND_MAKER_ADDRESS.toLowerCase();
  const filtered = bids.filter(
    (bid) =>
      bid.maker.toLowerCase() === makerLower &&
      (bid.status === 'OPEN' || bid.status === 'PARTIALLY_FILLED'),
  );
  logger.debug(
    { poolId: pool.poolId, rawBids: bids.length, filteredBids: filtered.length, maker: env.DEMAND_MAKER_ADDRESS },
    'filtered demand bids',
  );
  return filtered;
}

async function runCycle(signal: AbortSignal): Promise<DecisionResult[]> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const results: DecisionResult[] = [];

  const pools = await discoverEligiblePools(nowSeconds);
  logger.info({ eligiblePools: pools.length }, 'discovery cycle');

  await refreshPosition(pools.map((p) => p.poolId));

  for (const pool of pools) {
    if (signal.aborted) break;

    try {
      const bids = await discoverDemandBids(pool);
      logger.info({ poolId: pool.poolId, bids: bids.length }, 'discovered bids');

      for (const bid of bids) {
        if (signal.aborted) break;
        if (seenOrderHashes.has(bid.orderHash)) {
          logger.debug({ orderHash: bid.orderHash }, 'already processed bid');
          continue;
        }
        seenOrderHashes.add(bid.orderHash);

        const result = await evaluateBid(pool, bid);
        results.push(result);
        recentDecisions.push(result);
        if (recentDecisions.length > MAX_RECENT_DECISIONS) {
          recentDecisions.shift();
        }
      }

      // Post-expiry housekeeping for any cPT held in this pool.
      if (nowSeconds >= poolExpiryToSeconds(pool)) {
        await redeemPostExpiry(pool.poolId);
      }
    } catch (err) {
      logger.error({ poolId: pool.poolId, err }, 'error processing pool');
    }
  }

  // Keep the seen set bounded.
  if (seenOrderHashes.size > 10_000) {
    const toDelete = Array.from(seenOrderHashes).slice(0, seenOrderHashes.size - 5_000);
    for (const h of toDelete) seenOrderHashes.delete(h);
  }

  logger.info({ results: results.length }, 'discovery cycle complete');
  return results;
}

export async function startDiscoveryLoop(signal: AbortSignal): Promise<void> {
  logger.info({ intervalSeconds: 30 }, 'starting discovery loop');

  while (!signal.aborted) {
    const start = Date.now();
    try {
      await runCycle(signal);
    } catch (err) {
      logger.error({ err }, 'discovery cycle failed');
    }
    const elapsed = Date.now() - start;
    const sleep = Math.max(0, 30_000 - elapsed);
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, sleep);
        signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
      });
    }
  }

  logger.info('discovery loop stopped');
}

export { book };
