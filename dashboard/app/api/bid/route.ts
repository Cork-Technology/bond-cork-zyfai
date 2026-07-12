import { NextRequest, NextResponse } from "next/server";
import { PHOENIX_API_URL } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    console.log("[POST /api/bid] forwarding to Phoenix", JSON.stringify(body, null, 2));
    const res = await fetch(`${PHOENIX_API_URL}/v1/limit-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    console.log("[POST /api/bid] Phoenix response", res.status, JSON.stringify(data, null, 2));
    if (!res.ok) {
      return NextResponse.json(
        { error: `Phoenix ${res.status}`, details: data },
        { status: res.status }
      );
    }
    return NextResponse.json(data);
  } catch (err) {
    console.error("[POST /api/bid] exception", err);
    return NextResponse.json(
      { error: "Failed to fetch", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
