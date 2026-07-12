"use client";

import { truncate } from "@/lib/utils";
import { arbiscanTx } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2 } from "lucide-react";
import type { Hex } from "viem";

export type NegotiationEvent = {
  actor: "ZYFAI" | "BOND";
  action: string;
  detail?: string;
  timestamp?: string;
  txHash?: Hex;
  status?: "pending" | "done" | "counter";
};

function formatTime(iso?: string) {
  if (!iso) return "--:--:--";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function ActorBadge({ actor }: { actor: "ZYFAI" | "BOND" }) {
  const color =
    actor === "ZYFAI" ? "text-accent-on-dark" : "text-blue-action";
  return (
    <span className={`inline-block w-12 font-mono text-xs font-bold ${color}`}>
      {actor}
    </span>
  );
}

export function NegotiationFeed({
  events,
  title = "Negotiation feed",
  emptyText = "// No messages yet",
}: {
  events: NegotiationEvent[];
  title?: string;
  emptyText?: string;
}) {
  return (
    <Card className="grain h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            // LIVE
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          <div className="space-y-2 font-mono text-xs">
            {events.map((event, i) => (
              <div
                key={i}
                className="flex items-start gap-3 border-b border-[var(--hairline-dark)] pb-2 last:border-0 last:pb-0"
              >
                <span className="shrink-0 text-muted-foreground">
                  {formatTime(event.timestamp)}
                </span>
                <ActorBadge actor={event.actor} />
                <span className="shrink-0 text-muted-foreground">→</span>
                <div className="flex-1">
                  <span className="text-foreground">{event.action}</span>
                  {event.detail && (
                    <span className="ml-2 text-accent-on-dark">
                      {event.detail}
                    </span>
                  )}
                  {event.txHash && (
                    <a
                      href={arbiscanTx(event.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 inline-flex items-center gap-1 text-accent-on-dark hover:underline"
                    >
                      <CheckCircle2 className="size-3" />
                      {truncate(event.txHash)}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
