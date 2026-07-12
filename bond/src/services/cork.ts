import { type Hex } from 'viem';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

const CHAIN_ID = 42161;

export interface TokenInfo {
  address: Hex;
  name: string;
  symbol: string;
  decimals: number;
}

export interface PoolItem {
  poolId: Hex;
  expiry: string;
  collateralToken: TokenInfo;
  referenceToken: TokenInfo;
  principalToken: TokenInfo;
  swapToken: TokenInfo;
  isWhitelistEnabled: boolean;
  isDepositPaused: boolean;
  isSwapPaused: boolean;
  isWithdrawPaused: boolean;
  isUnwindDepositPaused: boolean;
  isUnwindSwapPaused: boolean;
  exerciseFeePercentage: number;
  repurchaseFeePercentage: number;
  tvl: string;
  collateralValue: string;
  referenceValue: string;
}

export function poolExpiryToSeconds(pool: PoolItem): number {
  const asNumber = Number(pool.expiry);
  if (!Number.isNaN(asNumber) && String(asNumber) === pool.expiry) {
    return asNumber;
  }
  const asDate = Date.parse(pool.expiry);
  if (!Number.isNaN(asDate)) {
    return Math.floor(asDate / 1000);
  }
  throw new Error(`Cannot parse pool expiry: ${pool.expiry}`);
}

export interface OrderItem {
  salt: string;
  maker: Hex;
  receiver: Hex;
  makerAsset: Hex;
  takerAsset: Hex;
  makingAmount: string;
  takingAmount: string;
  makerTraits: string;
  orderHash: Hex;
  signature: Hex;
  makerAccountType: 'EOA' | 'CONTRACT';
  extension: Hex;
  side: 'BUY' | 'SELL';
  premium: number;
  expiry: number;
  nonce: string;
  status: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
  remainingMakingAmount: string;
  remainingTakingAmount: string;
}

export interface FillsItem {
  orderHash: Hex;
  txHash: Hex;
  blockTimestamp: number;
  maker: Hex;
  taker: Hex;
  makingAmount: string;
  takingAmount: string;
  isPartialFill: boolean;
}

interface PaginatedResponse<T> {
  items: T[];
  nextCursor?: string;
  hasMore?: boolean;
}

async function apiGet<T>(path: string, params: Record<string, string | string[]>): Promise<T> {
  const url = new URL(`${env.CORK_API_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, value);
    }
  }
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cork API GET ${path} failed: ${res.status} ${body}`);
  }
  return (await res.json()) as T;
}

export async function* paginate<T>(
  fetchPage: (cursor?: string) => Promise<PaginatedResponse<T>>,
): AsyncGenerator<T, void, unknown> {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    for (const item of page.items) yield item;
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  } while (cursor);
}

export async function listPools(): Promise<PoolItem[]> {
  const params: Record<string, string | string[]> = { chainId: String(CHAIN_ID) };
  const page = await apiGet<PaginatedResponse<PoolItem>>('/v1/pools', params);
  logger.debug({ count: page.items.length }, 'listed pools');
  return page.items;
}

export async function listOrderbookBids(poolId: Hex): Promise<OrderItem[]> {
  const params: Record<string, string | string[]> = {
    chainId: String(CHAIN_ID),
    poolId,
    side: 'BUY',
  };
  params.status = ['OPEN', 'PARTIALLY_FILLED'];
  const page = await apiGet<PaginatedResponse<OrderItem>>('/v1/limit-orders/orderbook', params);
  logger.debug({ poolId, count: page.items.length }, 'listed orderbook bids');
  return page.items;
}

export async function listFillsByMaker(maker: Hex): Promise<FillsItem[]> {
  const params: Record<string, string | string[]> = {
    chainId: String(CHAIN_ID),
    maker,
  };
  const page = await apiGet<PaginatedResponse<FillsItem>>('/v1/limit-orders/fills', params);
  logger.debug({ maker, count: page.items.length }, 'listed fills by maker');
  return page.items;
}

export interface PostOrderPayload {
  salt: string;
  maker: Hex;
  receiver: Hex;
  makerAsset: Hex;
  takerAsset: Hex;
  makingAmount: string;
  takingAmount: string;
  makerTraits: string;
  orderHash: Hex;
  signature: Hex;
  makerAccountType: 'EOA' | 'CONTRACT';
  makerPermit2: string;
  extension: Hex;
  side: 'BUY' | 'SELL';
  premium: number;
  expiry: number;
  nonce: string;
  allowsPartialFills: boolean;
  chainId: number;
}

export async function postOrder(payload: PostOrderPayload): Promise<{ orderHash: Hex }> {
  const res = await fetch(`${env.CORK_API_URL}/v1/limit-orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { orderHash?: Hex; error?: string; message?: string };
  if (!res.ok) {
    throw new Error(
      `Cork API POST /v1/limit-orders failed: ${res.status} ${body.error ?? body.message ?? JSON.stringify(body)}`,
    );
  }
  if (!body.orderHash) {
    throw new Error('Cork API POST /v1/limit-orders returned no orderHash');
  }
  return { orderHash: body.orderHash };
}
