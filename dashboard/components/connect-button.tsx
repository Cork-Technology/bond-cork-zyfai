"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useChainId } from "wagmi";
import { Button } from "@/components/ui/button";
import { Wallet, LogOut, ChevronDown } from "lucide-react";

function truncateAddress(addr?: string) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function ConnectButton() {
  const { address, isConnected, isConnecting } = useAccount();
  const chainId = useChainId();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <Button variant="outline" disabled>
        <Wallet className="mr-2 size-4" />
        Connect
      </Button>
    );
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <div className="hidden flex-col items-end text-xs sm:flex">
          <span className="font-mono text-foreground">{truncateAddress(address)}</span>
          <span className="text-muted-foreground">Chain {chainId}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => disconnect()}
          title="Disconnect"
        >
          <LogOut className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Button
        variant="outline"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={isConnecting}
      >
        <Wallet className="mr-2 size-4" />
        {isConnecting ? "Connecting..." : "Connect"}
        <ChevronDown className="ml-2 size-4" />
      </Button>

      {menuOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-md border bg-popover p-2 shadow-md">
          <div className="text-xs text-muted-foreground px-2 py-1">Choose wallet</div>
          {connectors.map((connector) => (
            <Button
              key={connector.uid}
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                connect({ connector });
                setMenuOpen(false);
              }}
            >
              <Wallet className="mr-2 size-4" />
              {connector.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
