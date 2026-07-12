import { NextRequest, NextResponse } from "next/server";
import { PHOENIX_API_URL } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get("chainId");
  const poolId = req.nextUrl.searchParams.get("poolId");
  const side = req.nextUrl.searchParams.get("side");
  const status = req.nextUrl.searchParams.get("status");

  if (!chainId || !poolId) {
    return NextResponse.json(
      { error: "chainId and poolId required" },
      { status: 400 }
    );
  }

  const url = new URL(`${PHOENIX_API_URL}/v1/limit-orders/orderbook`);
  url.searchParams.set("chainId", chainId);
  url.searchParams.set("poolId", poolId);
  if (side) url.searchParams.set("side", side);
  if (status) url.searchParams.set("status", status);

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      next: { revalidate: 0 },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Phoenix ${res.status}`, details: text },
        { status: res.status }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
