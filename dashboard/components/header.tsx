"use client";

import { ConnectButton } from "@/components/connect-button";

export function Header() {
  return (
    <header className="flex flex-col gap-4 border-b border-[var(--hairline-dark)] pb-4 mb-6 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="font-display text-xl font-bold tracking-tight text-foreground">
          Coverage market demo
        </h1>
        <p className="mt-1 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          // Arbitrum One · Phoenix LOP v4
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--hairline-dark)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-success">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75"></span>
            <span className="relative inline-flex size-2 rounded-full bg-success"></span>
          </span>
          Live
        </span>
        <ConnectButton />
      </div>
    </header>
  );
}
