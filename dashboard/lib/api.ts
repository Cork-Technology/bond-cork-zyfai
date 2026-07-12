import { Hex } from "viem";
import {
  CHAIN_ID,
  ZYFAI_URL,
  BOND_URL,
} from "@/lib/constants";
import type {
  PhoenixPool,
  LimitOrder,
  Fill,
  OrderbookResponse,
  SafeOrderResponse,
  PostBidRequest,
  PostBidResponse,
  CancelOrderRequest,
  CancelOrderResponse,
  BondStatus,
  BondPosition,
} from "@/lib/types";

function getBaseUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${res.statusText} — ${url}\n${text}`);
  }
  return (await res.json()) as T;
}

export async function listPools(): Promise<PhoenixPool[]> {
  const data = await fetchJson<{ items: PhoenixPool[] }>(
    `/api/pools?chainId=${CHAIN_ID}`
  );
  return data.items;
}

export async function getPool(poolId: string): Promise<PhoenixPool | undefined> {
  const pools = await listPools();
  return pools.find((p) => p.poolId.toLowerCase() === poolId.toLowerCase());
}

export async function listOrderbook(
  poolId: string
): Promise<OrderbookResponse> {
  const url = new URL(`/api/orderbook`, typeof window !== "undefined" ? window.location.origin : undefined);
  url.searchParams.set("chainId", String(CHAIN_ID));
  url.searchParams.set("poolId", poolId);
  url.searchParams.set("status", "OPEN");

  const data = await fetchJson<{ items: LimitOrder[] }>(url.toString());
  const bids = data.items.filter((o) => o.side === "BUY");
  const asks = data.items.filter((o) => o.side === "SELL");
  return { bids, asks };
}

export async function listFills(poolId: string): Promise<Fill[]> {
  const url = new URL(`${getBaseUrl()}/api/fills`);
  url.searchParams.set("chainId", String(CHAIN_ID));
  url.searchParams.set("poolId", poolId);

  const data = await fetchJson<{ items: Fill[] }>(url.toString());
  return data.items;
}

export async function fetchSafeOrders(
  poolId?: string,
  side?: "BUY" | "SELL"
): Promise<LimitOrder[]> {
  const url = new URL(`${ZYFAI_URL}/orders`);
  if (poolId) url.searchParams.set("poolId", poolId);
  if (side) url.searchParams.set("side", side);
  const data = await fetchJson<SafeOrderResponse>(url.toString());
  return data.orders;
}

export async function postSafeBid(
  body: PostBidRequest
): Promise<PostBidResponse> {
  return fetchJson<PostBidResponse>(`${ZYFAI_URL}/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function cancelSafeOrder(
  body: CancelOrderRequest
): Promise<CancelOrderResponse> {
  return fetchJson<CancelOrderResponse>(`${ZYFAI_URL}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function fetchBondStatus(): Promise<BondStatus> {
  return fetchJson<BondStatus>(`${BOND_URL}/status`);
}

export async function fetchBondPosition(): Promise<BondPosition> {
  return fetchJson<BondPosition>(`${BOND_URL}/position`);
}
