"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useChainId,
  useReadContract,
  useSignTypedData,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from "wagmi";
import { erc20Abi, parseUnits, formatUnits } from "viem";
import { toast } from "sonner";
import { listPools, fetchBondStatus } from "@/lib/api";
import {
  buildBidOrder,
  orderTypedData,
  postPhoenixBid,
  fetchOrdersByMaker,
  orderToCancelArgs,
} from "@/lib/orders";
import { detectAccountType } from "@/lib/viem";
import { KNOWN_POOLS, FALLBACK_POOLS, CONTRACTS, CHAIN_ID, arbiscanTx } from "@/lib/constants";
import { truncate } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { NegotiationFeed } from "@/components/negotiation-feed";
import {
  Wallet,
  ShieldCheck,
  Upload,
  HandCoins,
  Loader2,
  ExternalLink,
  Inbox,
  CheckCircle2,
  Activity,
  Copy,
} from "lucide-react";
import type { Hex } from "viem";
import type { PhoenixPool, LimitOrder } from "@/lib/types";

const lopAbi = [
  {
    inputs: [
      {
        components: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "uint256" },
          { name: "receiver", type: "uint256" },
          { name: "makerAsset", type: "uint256" },
          { name: "takerAsset", type: "uint256" },
          { name: "makingAmount", type: "uint256" },
          { name: "takingAmount", type: "uint256" },
          { name: "makerTraits", type: "uint256" },
        ],
        name: "order",
        type: "tuple",
      },
    ],
    name: "cancelOrder",
    outputs: [{ name: "orderHash", type: "bytes32" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const MAX_UINT256 = 2n ** 256n - 1n;

function formatBps(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

function chainName(id?: number) {
  switch (id) {
    case 1:
      return "Ethereum";
    case 42161:
      return "Arbitrum One";
    case 137:
      return "Polygon";
    case 8453:
      return "Base";
    case 10:
      return "Optimism";
    default:
      return id ? `Chain ${id}` : "Unknown";
  }
}

export default function NegotiatePage() {
  const [selectedPoolId, setSelectedPoolId] = useState<string>(KNOWN_POOLS.sUSDe_yoUSD);
  const [size, setSize] = useState<string>("1000");
  const [premium, setPremium] = useState<string>("0.05");
  const [durationMinutes, setDurationMinutes] = useState<string>("60");
  const [lastPostedOrder, setLastPostedOrder] = useState<{ orderHash: Hex; timestamp: number } | undefined>(undefined);

  const queryClient = useQueryClient();
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const isWrongChain = chainId !== CHAIN_ID;

  const ensureArbitrum = async () => {
    if (chainId === CHAIN_ID) return;
    if (!switchChainAsync) {
      throw new Error(
        "Your wallet does not support automatic network switching. Please open your wallet and select Arbitrum One."
      );
    }
    const result = await switchChainAsync({ chainId: CHAIN_ID });
    if (result && result.id !== CHAIN_ID) {
      throw new Error(
        `Wallet switched to ${chainName(result.id)} instead of Arbitrum One. Please switch manually.`
      );
    }
  };

  const {
    data: pools,
    isLoading: poolsLoading,
    error: poolsError,
  } = useQuery({
    queryKey: ["pools"],
    queryFn: listPools,
  });

  const effectivePools = useMemo(
    () => (pools && pools.length > 0 ? pools : [...FALLBACK_POOLS]),
    [pools]
  );

  const selectedPool = useMemo(
    () => effectivePools.find((p) => p.poolId === selectedPoolId),
    [effectivePools, selectedPoolId]
  );

  const { data: bondStatus } = useQuery({
    queryKey: ["bond-status"],
    queryFn: fetchBondStatus,
  });

  const { data: myOrders, isLoading: ordersLoading } = useQuery({
    queryKey: ["my-orders", address, selectedPoolId],
    queryFn: () => fetchOrdersByMaker(address!, selectedPoolId, "BUY"),
    enabled: !!address && !!selectedPoolId,
  });

  const premiumCa = useMemo(() => {
    if (!selectedPool || !size || !premium) return 0n;
    try {
      const sizeCst = parseUnits(size, selectedPool.swapToken.decimals);
      const price = Number(premium) / Number(size);
      const priceScaled = BigInt(Math.round(price * 1e9));
      return (
        (sizeCst * priceScaled * 10n ** BigInt(selectedPool.collateralToken.decimals)) /
        (10n ** 9n * 10n ** 18n)
      );
    } catch {
      return 0n;
    }
  }, [selectedPool, size, premium]);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: selectedPool?.collateralToken.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && selectedPool ? [address, CONTRACTS.LOP] : undefined,
    query: { enabled: !!address && !!selectedPool },
  });

  const needsApproval =
    selectedPool && allowance !== undefined && premiumCa > 0n
      ? allowance < premiumCa
      : false;

  const approve = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data });
  const lastApprovedHash = useRef<string | undefined>(undefined);
  const [lastApprovalTx, setLastApprovalTx] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (
      approveReceipt.isSuccess &&
      approve.data &&
      lastApprovedHash.current !== approve.data
    ) {
      lastApprovedHash.current = approve.data;
      setLastApprovalTx(approve.data);
      toast.success("Premium token approved", {
        description: `Tx ${truncate(approve.data)}`,
      });
      queryClient.invalidateQueries({
        queryKey: ["my-orders", address, selectedPoolId],
      });
      refetchAllowance();
    }
  }, [approveReceipt.isSuccess, approve.data, address, selectedPoolId, queryClient, refetchAllowance]);

  const { signTypedDataAsync } = useSignTypedData();

  const postBid = useMutation({
    mutationFn: async () => {
      if (!isConnected || !address) throw new Error("Connect your wallet first");
      if (!selectedPool) throw new Error("Select a market");

      await ensureArbitrum();

      const walletProvider = connector ? await connector.getProvider() : undefined;
      const makerAccountType = await detectAccountType(address, walletProvider as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> } | undefined);
      const expirySeconds = Math.max(60, Number(durationMinutes || 0) * 60);
      const order = buildBidOrder(selectedPool, address, size, premium, expirySeconds);
      const typedData = orderTypedData(CHAIN_ID, order);
      const signature = await signTypedDataAsync(typedData);
      const res = await postPhoenixBid(
        selectedPool,
        order,
        signature,
        Number(premium),
        makerAccountType
      );
      return res;
    },
    onSuccess: (res) => {
      setLastPostedOrder({ orderHash: res.orderHash, timestamp: Date.now() });
      toast.success("Cover request posted", {
        description: `Order ${truncate(res.orderHash)}. It is now live on the Phoenix orderbook and will settle on-chain when an underwriter fills it.`,
      });
      queryClient.invalidateQueries({ queryKey: ["my-orders", address, selectedPoolId] });
      queryClient.invalidateQueries({ queryKey: ["orderbook", selectedPoolId] });
    },
    onError: (err) => {
      toast.error("Failed to post cover request", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const cancel = useWriteContract();
  const cancelReceipt = useWaitForTransactionReceipt({ hash: cancel.data });
  const [lastCancelTx, setLastCancelTx] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (
      cancelReceipt.isSuccess &&
      cancel.data &&
      lastCancelTx !== cancel.data
    ) {
      setLastCancelTx(cancel.data);
      toast.success("Request cancelled", {
        description: `Tx ${truncate(cancel.data)}`,
      });
      queryClient.invalidateQueries({
        queryKey: ["my-orders", address, selectedPoolId],
        refetchType: "all",
      });
      queryClient.invalidateQueries({
        queryKey: ["orderbook", selectedPoolId],
        refetchType: "all",
      });
    }
  }, [cancelReceipt.isSuccess, cancel.data, lastCancelTx, address, selectedPoolId, queryClient]);

  const cancelOrder = async (order: LimitOrder) => {
    try {
      await ensureArbitrum();
      const args = orderToCancelArgs(order);
      cancel.writeContract({
        address: CONTRACTS.LOP,
        abi: lopAbi,
        functionName: "cancelOrder",
        chainId: CHAIN_ID,
        args: [args],
      });
    } catch (err) {
      toast.error("Cancel failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const marketOptions = useMemo(() => {
    const fromApi = effectivePools ?? [];
    const known = [
      { poolId: KNOWN_POOLS.USDC_yoUSD, label: "USDC / yoUSD" },
      { poolId: KNOWN_POOLS.sUSDe_yoUSD, label: "sUSDe / yoUSD" },
    ];
    const byId = new Map<string, { poolId: string; label: string }>();
    for (const k of known) byId.set(k.poolId, k);
    for (const p of fromApi) {
      byId.set(p.poolId, {
        poolId: p.poolId,
        label: `${p.collateralToken.symbol} / ${p.referenceToken.symbol}`,
      });
    }
    return Array.from(byId.values());
  }, [effectivePools]);

  const blockers = useMemo(() => {
    const list: string[] = [];
    if (!isConnected) list.push("Wallet not connected");
    if (!selectedPool) list.push("No market selected");
    if (premiumCa <= 0n) list.push("Enter a valid cover size and premium");
    if (Number(durationMinutes) <= 0) list.push("Enter a valid duration");
    if (needsApproval) list.push("Approve premium token before posting");
    return list;
  }, [isConnected, selectedPool, premiumCa, durationMinutes, needsApproval]);

  const feedEvents = useMemo(() => {
    const events: { actor: "ZYFAI" | "BOND"; action: string; detail?: string; timestamp?: string; txHash?: Hex }[] = [];
    (myOrders ?? []).forEach((order) => {
      events.push({
        actor: "ZYFAI",
        action: "REQUEST COVER",
        detail: `${order.takingAmount} ${selectedPool?.referenceToken.symbol} @ ${order.premium} bps`,
        timestamp: order.createdAt,
      });
    });
    if (lastCancelTx) {
      events.push({
        actor: "ZYFAI",
        action: "CANCELLED REQUEST",
        timestamp: new Date().toISOString(),
        txHash: lastCancelTx as Hex,
      });
    }
    return events.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  }, [myOrders, lastCancelTx, selectedPool]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          // NEGOTIATE
        </span>
        <h1 className="font-display text-3xl font-bold tracking-tight text-foreground">
          Request insurance cover
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Protect your position against a depeg. Connect your wallet, choose a market, and request a cover price from underwriters.
        </p>
      </div>

      {isWrongChain && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="space-y-3 py-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-display font-bold">Wrong network</p>
                <p className="text-sm text-muted-foreground">
                  Your wallet is on {chainName(chainId ?? undefined)}. This app trades on Arbitrum One.
                </p>
              </div>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await switchChainAsync?.({ chainId: CHAIN_ID });
                  } catch (err) {
                    toast.error("Could not switch network", {
                      description: err instanceof Error ? err.message : "Open your wallet and manually select Arbitrum One.",
                    });
                  }
                }}
              >
                Switch network
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  // MARKET
                </span>
                Choose pool
              </CardTitle>
              <CardDescription>
                Pick the collateral and reference asset you want insurance on.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {poolsLoading ? (
                <Skeleton className="h-10 w-72" />
              ) : (
                <Select
                  value={selectedPoolId}
                  onValueChange={(value) => value && setSelectedPoolId(value)}
                >
                  <SelectTrigger className="w-full sm:w-96">
                    <SelectValue placeholder="Pick a market" />
                  </SelectTrigger>
                  <SelectContent>
                    {marketOptions.map((m) => (
                      <SelectItem key={m.poolId} value={m.poolId}>
                        {m.label}{" "}
                        <span className="text-muted-foreground">({truncate(m.poolId)})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {poolsError && (
                <div className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  <p className="font-medium">Could not load live markets</p>
                  <p>{poolsError instanceof Error ? poolsError.message : "Unknown error"}</p>
                  <p className="mt-1">Using cached market data instead.</p>
                </div>
              )}
              {selectedPool && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant="outline">{selectedPool.collateralToken.symbol} premium</Badge>
                  <Badge variant="outline">{selectedPool.referenceToken.symbol} reference</Badge>
                  <Badge variant="outline">Floor {formatBps(bondStatus?.floorPremiumBps ?? 0)}</Badge>
                  <a
                    href={`https://arbiscan.io/address/${selectedPool.poolId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs hover:underline"
                  >
                    {truncate(selectedPool.poolId)} <ExternalLink className="size-3" />
                  </a>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  // REQUEST
                </span>
                Post a cover request
              </CardTitle>
              <CardDescription>
                You pay {selectedPool?.collateralToken.symbol ?? "collateral"} premium and receive cover that protects your {selectedPool?.referenceToken.symbol ?? "reference"} position.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="size" className="font-mono text-[10px] uppercase tracking-wider">
                    Cover amount
                  </Label>
                  <Input
                    id="size"
                    type="number"
                    min="0"
                    step="0.1"
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    disabled={!isConnected}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="premium" className="font-mono text-[10px] uppercase tracking-wider">
                    Premium price ({selectedPool?.collateralToken.symbol})
                  </Label>
                  <Input
                    id="premium"
                    type="number"
                    min="0"
                    step="0.001"
                    value={premium}
                    onChange={(e) => setPremium(e.target.value)}
                    disabled={!isConnected}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="duration" className="font-mono text-[10px] uppercase tracking-wider">
                    Duration (minutes)
                  </Label>
                  <Input
                    id="duration"
                    type="number"
                    min="1"
                    step="1"
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(e.target.value)}
                    disabled={!isConnected}
                  />
                </div>
              </div>

              <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Implied premium</span>
                  <span className="font-mono font-medium">
                    {size && Number(size) > 0
                      ? `${((Number(premium) / Number(size)) * 10000).toFixed(0)} bps`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Total premium</span>
                  <span className="font-mono font-medium">
                    {selectedPool && premiumCa > 0n
                      ? `${formatUnits(premiumCa, selectedPool.collateralToken.decimals)} ${selectedPool.collateralToken.symbol}`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Allowance</span>
                  <span className="font-mono font-medium">
                    {selectedPool && allowance !== undefined
                      ? `${formatUnits(allowance, selectedPool.collateralToken.decimals)} ${selectedPool.collateralToken.symbol}`
                      : "—"}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={async () => {
                    if (!selectedPool) return;
                    try {
                      await ensureArbitrum();
                      approve.writeContract({
                        address: selectedPool.collateralToken.address,
                        abi: erc20Abi,
                        functionName: "approve",
                        args: [CONTRACTS.LOP, MAX_UINT256],
                        chainId: CHAIN_ID,
                      });
                    } catch (err) {
                      toast.error("Approve failed", {
                        description: err instanceof Error ? err.message : "Unknown error",
                      });
                    }
                  }}
                  disabled={!isConnected || !selectedPool || approve.isPending}
                  variant={needsApproval ? "default" : "outline"}
                >
                  {approve.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  <ShieldCheck className="mr-2 size-4" />
                  Approve premium token
                </Button>

                <Button
                  onClick={() => postBid.mutate()}
                  disabled={
                    !isConnected ||
                    !selectedPool ||
                    postBid.isPending ||
                    needsApproval ||
                    Number(size) <= 0 ||
                    Number(premium) <= 0 ||
                    Number(durationMinutes) <= 0
                  }
                >
                  {postBid.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  <Upload className="mr-2 size-4" />
                  Post cover request
                </Button>
              </div>

              {blockers.length > 0 && (
                <div className="rounded-[var(--radius-brand)] border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700">
                  <p className="font-medium">Buttons disabled because:</p>
                  <ul className="list-inside list-disc">
                    {blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}

              {(approve.error || postBid.error) && (
                <div className="rounded-[var(--radius-brand)] border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  {approve.error && <p>Approve error: {approve.error.message}</p>}
                  {postBid.error && <p>Post request error: {postBid.error.message}</p>}
                </div>
              )}
            </CardContent>
          </Card>

          {lastApprovalTx && (
            <Card className="border-success/30 bg-success/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4" />
                  Approval confirmed
                </CardTitle>
              </CardHeader>
              <CardContent>
                <a
                  href={arbiscanTx(lastApprovalTx)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 font-mono text-xs text-accent-on-dark hover:underline"
                >
                  <ExternalLink className="size-3" />
                  Approved premium token · {truncate(lastApprovalTx)}
                </a>
              </CardContent>
            </Card>
          )}

          {lastCancelTx && (
            <Card className="border-success/30 bg-success/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4" />
                  Recent transaction
                </CardTitle>
              </CardHeader>
              <CardContent>
                <a
                  href={arbiscanTx(lastCancelTx)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 font-mono text-xs text-accent-on-dark hover:underline"
                >
                  <ExternalLink className="size-3" />
                  Cancelled request · {truncate(lastCancelTx)}
                </a>
              </CardContent>
            </Card>
          )}

          {lastPostedOrder && (
            <Card className="border-success/30 bg-success/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4" />
                  Request posted
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Order hash (off-chain until filled):
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-[var(--radius-brand)] bg-surface-2 p-2 font-mono text-xs">
                    {lastPostedOrder.orderHash}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(lastPostedOrder.orderHash);
                      toast.success("Order hash copied");
                    }}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  This is an off-chain order hash. An on-chain tx hash will appear here once an underwriter fills it.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Inbox className="size-5" />
                Your open cover requests
              </CardTitle>
              <CardDescription>
                Requests you have posted. Cancel any that are no longer needed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!isConnected ? (
                <p className="text-sm text-muted-foreground">
                  Connect your wallet to see your requests.
                </p>
              ) : ordersLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (myOrders ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No open cover requests from {truncate(address)} on this pool.
                  <br />
                  <span className="text-xs">Filled, cancelled, or expired requests are no longer listed.</span>
                </p>
              ) : (
                <div className="space-y-3">
                  {(myOrders ?? []).map((order) => (
                    <div
                      key={order.orderHash}
                      className="flex flex-col gap-2 rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Badge variant="default">{order.side}</Badge>
                          <span className="font-mono">{order.premium} bps premium</span>
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {truncate(order.orderHash)}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">
                          Paying {order.makingAmount} / Receiving {order.takingAmount}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cancel.isPending}
                        onClick={() => cancelOrder(order)}
                      >
                        {cancel.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                        Cancel
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <NegotiationFeed events={feedEvents} title="Live transcript" />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <HandCoins className="size-5" />
                Underwriter terms
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Floor premium</span>
                <span className="font-mono">{formatBps(bondStatus?.floorPremiumBps ?? 0)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Counter margin</span>
                <span className="font-mono">{formatBps(bondStatus?.counterMarginBps ?? 0)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Max position</span>
                <span className="font-mono text-xs">{bondStatus?.maxCaPosition ?? "—"}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Utilization</span>
                <span className="font-mono">
                  {bondStatus ? `${(bondStatus.utilizationBps / 100).toFixed(2)}%` : "—"}
                </span>
              </div>
              <Separator />
              <p className="text-xs text-muted-foreground">
                Underwriters scan Phoenix and fill any open cover request whose premium is at or above the floor. Post at or above{" "}
                {formatBps(bondStatus?.floorPremiumBps ?? 0)} to get filled quickly.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="size-5" />
                Pricing signal
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  // PRICING v1 — HEURISTIC
                </span>
                <Badge variant="outline">BETA</Badge>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Market pressure</span>
                  <span className="font-mono font-medium text-success">Low</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full bg-success transition-all" style={{ width: "35%" }} />
                </div>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Floor</span>
                <span className="font-mono">{formatBps(bondStatus?.floorPremiumBps ?? 0)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Suggested bid</span>
                <span className="font-mono">{formatBps((bondStatus?.floorPremiumBps ?? 0))}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
