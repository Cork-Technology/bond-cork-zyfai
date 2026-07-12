import { type Hex } from 'viem';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { publicClient, BOND_ADDRESS, erc20Abi, poolManagerAbi } from './chain.js';
import { getPoolTokens } from './adapter.js';

export interface PoolPosition {
  poolId: Hex;
  cst: Hex;
  cpt: Hex;
  cstBalance: bigint;
  cptBalance: bigint;
}

export interface Book {
  caBalance: bigint;
  caLockedInOpenOrders: bigint;
  caAtRiskFromFills: bigint;
  pools: Map<Hex, PoolPosition>;
  orderHashes: Set<Hex>;
}

export const book: Book = {
  caBalance: 0n,
  caLockedInOpenOrders: 0n,
  caAtRiskFromFills: 0n,
  pools: new Map(),
  orderHashes: new Set(),
};

export function caExposure(): bigint {
  return book.caLockedInOpenOrders + book.caAtRiskFromFills;
}

export function remainingCaCapacity(): bigint {
  const used = caExposure();
  return used >= env.MAX_CA_POSITION ? 0n : env.MAX_CA_POSITION - used;
}

export async function refreshPosition(poolIds: Hex[]): Promise<void> {
  book.caBalance = await publicClient.readContract({
    address: env.CA_TOKEN,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [BOND_ADDRESS],
  });

  for (const poolId of poolIds) {
    const tokens = await getPoolTokens(poolId);
    const [cstBalance, cptBalance] = await Promise.all([
      publicClient.readContract({ address: tokens.cst, abi: erc20Abi, functionName: 'balanceOf', args: [BOND_ADDRESS] }),
      publicClient.readContract({ address: tokens.cpt, abi: erc20Abi, functionName: 'balanceOf', args: [BOND_ADDRESS] }),
    ]);
    book.pools.set(poolId, { poolId, cst: tokens.cst, cpt: tokens.cpt, cstBalance, cptBalance });
  }

  logger.debug(
    {
      caBalance: book.caBalance.toString(),
      caExposure: caExposure().toString(),
      pools: Array.from(book.pools.entries()).map(([poolId, p]) => ({
        poolId,
        cstBalance: p.cstBalance.toString(),
        cptBalance: p.cptBalance.toString(),
      })),
    },
    'refreshed position',
  );
}

export async function redeemPostExpiry(poolId: Hex): Promise<Hex | undefined> {
  const pos = book.pools.get(poolId);
  if (!pos || pos.cptBalance === 0n) return undefined;

  const market = await publicClient.readContract({
    address: env.CORK_POOL_MANAGER,
    abi: poolManagerAbi,
    functionName: 'market',
    args: [poolId],
  });
  const block = await publicClient.getBlock();
  if (Number(block.timestamp) < Number(market.expiryTimestamp)) {
    logger.debug({ poolId }, 'pool not expired yet; skipping redemption');
    return undefined;
  }

  const { walletClient, account } = await import('./chain.js');
  const { request } = await publicClient.simulateContract({
    address: env.CORK_POOL_MANAGER,
    abi: poolManagerAbi,
    functionName: 'redeem',
    args: [poolId, pos.cptBalance, BOND_ADDRESS, BOND_ADDRESS],
    account: BOND_ADDRESS,
  });
  const hash = await walletClient.writeContract({ ...request, account });
  logger.info({ poolId, cptBurned: pos.cptBalance.toString(), txHash: hash }, 'redeemed cPT post-expiry');
  return hash;
}
