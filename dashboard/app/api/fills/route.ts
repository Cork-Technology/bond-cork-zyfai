import { NextRequest, NextResponse } from "next/server";
import { PHOENIX_API_URL } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get("chainId");
  const poolId = req.nextUrl.searchParams.get("poolId");
  const maker = req.nextUrl.searchParams.get("maker");
  const taker = req.nextUrl.searchParams.get("taker");

  if (!chainId) {
    return NextResponse.json({ error: "chainId required" }, { status: 400 });
  }

  const url = new URL(`${PHOENIX_API_URL}/v1/limit-orders/fills`);
  url.searchParams.set("chainId", chainId);
  if (poolId) url.searchParams.set("poolId", poolId);
  if (maker) url.searchParams.set("maker", maker);
  if (taker) url.searchParams.set("taker", taker);

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
