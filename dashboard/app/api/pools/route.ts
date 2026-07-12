import { NextRequest, NextResponse } from "next/server";
import { PHOENIX_API_URL } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get("chainId");
  if (!chainId) {
    return NextResponse.json({ error: "chainId required" }, { status: 400 });
  }

  try {
    const url = `${PHOENIX_API_URL}/v1/pools?chainId=${encodeURIComponent(chainId)}`;
    const res = await fetch(url, {
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
    return NextResponse.json(data, {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
