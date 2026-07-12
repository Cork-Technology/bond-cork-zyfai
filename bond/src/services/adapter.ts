import { type Hex } from 'viem';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { publicClient, walletClient, account, BOND_ADDRESS, erc20Abi, poolManagerAbi } from './chain.js';

export async function getPoolTokens(poolId: Hex): Promise<{ cst: Hex; cpt: Hex }> {
  const [cpt, cst] = await publicClient.readContract({
    address: env.CORK_POOL_MANAGER,
    abi: poolManagerAbi,
    functionName: 'shares',
    args: [poolId],
  });
  return { cst, cpt };
}

export async function previewMint(poolId: Hex, shares: bigint): Promise<bigint> {
  const assets = await publicClient.readContract({
    address: env.CORK_POOL_MANAGER,
    abi: poolManagerAbi,
    functionName: 'previewMint',
    args: [poolId, shares],
  });
  return assets;
}

export async function isMarketFillable(
  poolId: Hex,
  isWhitelistEnabledFromApi?: boolean,
): Promise<{
  ok: boolean;
  paused: boolean;
  whitelisted: boolean;
  expired: boolean;
  reason?: string;
}> {
  const market = await publicClient.readContract({
    address: env.CORK_POOL_MANAGER,
    abi: poolManagerAbi,
    functionName: 'market',
    args: [poolId],
  });
  const pausedBitmap = await publicClient.readContract({
    address: env.CORK_POOL_MANAGER,
    abi: poolManagerAbi,
    functionName: 'getPausedBitMap',
    args: [poolId],
  });
  const block = await publicClient.getBlock();
  const now = Number(block.timestamp);
  const expired = now >= Number(market.expiryTimestamp);
  const depositPaused = (pausedBitmap & 0b0000_0000_0000_0001) !== 0;

  if (expired) return { ok: false, paused: false, whitelisted: false, expired: true, reason: 'pool expired' };
  if (depositPaused) return { ok: false, paused: true, whitelisted: false, expired: false, reason: 'deposit paused' };

  // JIT markets must have the whitelist disabled. We already have the flag
  // from the Cork API; use it directly to avoid the noisy on-chain call.
  if (isWhitelistEnabledFromApi === true) {
    return { ok: false, paused: false, whitelisted: true, expired: false, reason: 'whitelist enabled' };
  }

  return { ok: true, paused: false, whitelisted: false, expired: false };
}

export async function ensureApproval(
  token: Hex,
  spender: Hex,
  needed: bigint,
): Promise<Hex | undefined> {
  const current = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [BOND_ADDRESS, spender],
  });
  if (current >= needed) return undefined;

  const { request } = await publicClient.simulateContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, needed],
    account: BOND_ADDRESS,
  });
  const hash = await walletClient.writeContract({ ...request, account });
  logger.info({ token, spender, amount: needed.toString(), txHash: hash }, 'approved token');

  // Wait for the approval to be reflected on the RPC's latest block before
  // the next simulation/transaction. This prevents "TransferFrom...Failed"
  // reverts caused by stale node state right after the tx lands.
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`approve transaction failed: ${hash}`);
  }

  for (let i = 0; i < 30; i++) {
    const updated = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [BOND_ADDRESS, spender],
    });
    if (updated >= needed) return hash;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`allowance did not update after approve: ${hash}`);
}

export async function getBalance(token: Hex): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [BOND_ADDRESS],
  });
}
