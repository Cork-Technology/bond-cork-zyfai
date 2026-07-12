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
import { detectAccountType, publicClient } from "@/lib/viem";
import {
  buildAskOrder,
  orderTypedData,
  postPhoenixAsk,
  fetchOrdersByMaker,
  fetchBidsForPool,
  orderToCancelArgs,
  prepareLiftBid,
  toCompactSignature,
  FILL_ORDER_ARGS_ABI_WITH_ERRORS,
  FILL_CONTRACT_ORDER_ARGS_ABI_WITH_ERRORS,
} from "@/lib/orders";
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

export default function UnderwritePage() {
  const [selectedPoolId, setSelectedPoolId] = useState<string>(KNOWN_POOLS.sUSDe_yoUSD);
  const [size, setSize] = useState<string>("1");
  const [premium, setPremium] = useState<string>("0.005");
  const [durationMinutes, setDurationMinutes] = useState<string>("60");

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
    queryKey: ["my-orders-ask", address, selectedPoolId],
    queryFn: () => fetchOrdersByMaker(address!, selectedPoolId, "SELL"),
    enabled: !!address && !!selectedPoolId,
  });

  const { data: openBids, isLoading: bidsLoading } = useQuery({
    queryKey: ["open-bids", selectedPoolId],
    queryFn: () => fetchBidsForPool(selectedPoolId),
    enabled: !!selectedPoolId,
  });

  const { data: bidAllowances } = useQuery({
    queryKey: ["bid-allowances", selectedPoolId, openBids?.map((b) => b.orderHash).join(",")],
    queryFn: async () => {
      if (!selectedPool || !openBids || openBids.length === 0) return {};
      const entries = await Promise.all(
        openBids.map(async (bid) => {
          try {
            const allowance = await publicClient.readContract({
              address: selectedPool.collateralToken.address,
              abi: erc20Abi,
              functionName: "allowance",
              args: [bid.maker, CONTRACTS.LOP],
            });
            return [bid.orderHash, allowance] as const;
          } catch {
            return [bid.orderHash, 0n] as const;
          }
        })
      );
      return Object.fromEntries(entries) as Record<string, bigint>;
    },
    enabled: !!selectedPool && !!openBids && openBids.length > 0,
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

  const sizeCst = useMemo(() => {
    if (!selectedPool || !size) return 0n;
    try {
      return parseUnits(size, selectedPool.swapToken.decimals);
    } catch {
      return 0n;
    }
  }, [selectedPool, size]);

  const { data: caAllowanceAdapter, refetch: refetchCaAllowance } = useReadContract({
    address: selectedPool?.collateralToken.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && selectedPool ? [address, CONTRACTS.ADAPTER] : undefined,
    query: { enabled: !!address && !!selectedPool },
  });

  const { data: cstAllowanceLop, refetch: refetchCstAllowance } = useReadContract({
    address: selectedPool?.swapToken.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && selectedPool ? [address, CONTRACTS.LOP] : undefined,
    query: { enabled: !!address && !!selectedPool },
  });

  const needsCaApproval =
    selectedPool && caAllowanceAdapter !== undefined && premiumCa > 0n
      ? caAllowanceAdapter < premiumCa
      : false;

  const needsCstApproval =
    selectedPool && cstAllowanceLop !== undefined && sizeCst > 0n
      ? cstAllowanceLop < sizeCst
      : false;

  const approve = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data });
  const lastApprovedHash = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (
      approveReceipt.isSuccess &&
      approve.data &&
      lastApprovedHash.current !== approve.data
    ) {
      lastApprovedHash.current = approve.data;
      toast.success("Approval confirmed");
      refetchCaAllowance();
      refetchCstAllowance();
    }
  }, [approveReceipt.isSuccess, approve.data, refetchCaAllowance, refetchCstAllowance]);

  const { signTypedDataAsync } = useSignTypedData();

  const postAsk = useMutation({
    mutationFn: async () => {
      if (!isConnected || !address) throw new Error("Connect your wallet first");
      if (!selectedPool) throw new Error("Select a pool");

      await ensureArbitrum();

      const walletProvider = connector ? await connector.getProvider() : undefined;
      const makerAccountType = await detectAccountType(address, walletProvider as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> } | undefined);
      const expirySeconds = Math.max(60, Number(durationMinutes || 0) * 60);
      const { order, extension } = buildAskOrder(
        selectedPool,
        address,
        size,
        premium,
        expirySeconds
      );
      const typedData = orderTypedData(CHAIN_ID, order);
      const signature = await signTypedDataAsync(typedData);
      const res = await postPhoenixAsk(
        selectedPool,
        order,
        signature,
        extension,
        Number(premium),
        makerAccountType
      );
      return res;
    },
    onSuccess: (res) => {
      toast.success("Cover offer posted", {
        description: `Order ${truncate(res.orderHash)}`,
      });
      queryClient.invalidateQueries({ queryKey: ["my-orders-ask", address, selectedPoolId] });
      queryClient.invalidateQueries({ queryKey: ["orderbook", selectedPoolId] });
    },
    onError: (err) => {
      toast.error("Failed to post cover offer", {
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
      toast.success("Offer cancelled", {
        description: `Tx ${truncate(cancel.data)}`,
      });
      queryClient.invalidateQueries({
        queryKey: ["my-orders-ask", address, selectedPoolId],
        refetchType: "all",
      });
      queryClient.invalidateQueries({
        queryKey: ["open-bids", selectedPoolId],
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

  const lift = useWriteContract();
  const liftReceipt = useWaitForTransactionReceipt({ hash: lift.data });
  const [lastLiftTx, setLastLiftTx] = useState<string | undefined>(undefined);
  const [liftingOrderHash, setLiftingOrderHash] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (lift.error && liftingOrderHash) {
      setLiftingOrderHash(undefined);
      toast.error("Fill submission failed", {
        description: lift.error.message,
      });
    }
  }, [lift.error, liftingOrderHash]);

  useEffect(() => {
    if (!lift.isPending && !lift.error && liftingOrderHash && lift.data) {
      // writeContract submitted; tx receipt effect will handle final success
      setLiftingOrderHash(undefined);
    }
  }, [lift.isPending, lift.error, liftingOrderHash, lift.data]);

  useEffect(() => {
    if (
      liftReceipt.isSuccess &&
      lift.data &&
      lastLiftTx !== lift.data
    ) {
      setLastLiftTx(lift.data);
      toast.success("Cover request filled", {
        description: `Tx ${truncate(lift.data)}`,
      });
      queryClient.invalidateQueries({ queryKey: ["open-bids", selectedPoolId], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["my-orders-ask", address, selectedPoolId], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["orderbook", selectedPoolId], refetchType: "all" });
    }
  }, [liftReceipt.isSuccess, lift.data, lastLiftTx, address, selectedPoolId, queryClient]);

  const liftBid = async (bid: LimitOrder) => {
    try {
      if (!selectedPool) throw new Error("Select a pool");
      await ensureArbitrum();
      setLiftingOrderHash(bid.orderHash);
      const { orderArgs, signature, amount, traits, args, isContract } =
        prepareLiftBid(bid, selectedPool.poolId as Hex);

      if (isContract) {
        lift.writeContract({
          address: CONTRACTS.LOP,
          abi: FILL_CONTRACT_ORDER_ARGS_ABI_WITH_ERRORS,
          functionName: "fillContractOrderArgs",
          args: [orderArgs, signature, amount, traits, args],
          chainId: CHAIN_ID,
        });
      } else {
        const { r, vs } = toCompactSignature(signature);
        lift.writeContract({
          address: CONTRACTS.LOP,
          abi: FILL_ORDER_ARGS_ABI_WITH_ERRORS,
          functionName: "fillOrderArgs",
          args: [orderArgs, r, vs, amount, traits, args],
          chainId: CHAIN_ID,
        });
      }
    } catch (err) {
      setLiftingOrderHash(undefined);
      toast.error("Fill failed", {
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
    if (premiumCa <= 0n) list.push("Enter a valid cover amount and premium");
    if (Number(durationMinutes) <= 0) list.push("Enter a valid duration");
    return list;
  }, [isConnected, selectedPool, premiumCa, durationMinutes]);

  const feedEvents = useMemo(() => {
    const events: { actor: "ZYFAI" | "BOND"; action: string; detail?: string; timestamp?: string; txHash?: Hex }[] = [];
    (openBids ?? []).forEach((bid) => {
      events.push({
        actor: "ZYFAI",
        action: "REQUEST COVER",
        detail: `${formatUnits(BigInt(bid.takingAmount), selectedPool?.swapToken.decimals ?? 18)} ${selectedPool?.referenceToken.symbol} @ ${bid.premium} bps`,
        timestamp: bid.createdAt,
      });
    });
    if (lastLiftTx) {
      events.push({ actor: "BOND", action: "FILLED REQUEST", timestamp: new Date().toISOString(), txHash: lastLiftTx as Hex });
    }
    if (lastCancelTx) {
      events.push({ actor: "BOND", action: "CANCELLED OFFER", timestamp: new Date().toISOString(), txHash: lastCancelTx as Hex });
    }
    return events.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  }, [openBids, lastLiftTx, lastCancelTx, selectedPool]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          // UNDERWRITE
        </span>
        <h1 className="font-display text-3xl font-bold tracking-tight text-foreground">
          Provide insurance cover
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Back a position and earn premium plus yield on your collateral. Just-in-time minting means you do not need cover tokens in your wallet upfront.
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
                Pick the collateral and reference asset you want to provide cover on.
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
                  <Badge variant="outline">{selectedPool.collateralToken.symbol} collateral</Badge>
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
                  // OFFER
                </span>
                Post a cover offer
              </CardTitle>
              <CardDescription>
                You offer cover on {selectedPool?.referenceToken.symbol ?? "the reference asset"} and receive{" "}
                {selectedPool?.collateralToken.symbol ?? "collateral"} premium.
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
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Total premium you receive</span>
                  <span className="font-mono font-medium">
                    {selectedPool && premiumCa > 0n
                      ? `${formatUnits(premiumCa, selectedPool.collateralToken.decimals)} ${selectedPool.collateralToken.symbol}`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Collateral allowance</span>
                  <span className="font-mono font-medium">
                    {selectedPool && caAllowanceAdapter !== undefined
                      ? `${formatUnits(caAllowanceAdapter, selectedPool.collateralToken.decimals)} ${selectedPool.collateralToken.symbol}`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Cover allowance</span>
                  <span className="font-mono font-medium">
                    {selectedPool && cstAllowanceLop !== undefined
                      ? `${formatUnits(cstAllowanceLop, selectedPool.swapToken.decimals)} ${selectedPool.swapToken.symbol}`
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
                        args: [CONTRACTS.ADAPTER, MAX_UINT256],
                        chainId: CHAIN_ID,
                      });
                    } catch (err) {
                      toast.error("Approve failed", {
                        description: err instanceof Error ? err.message : "Unknown error",
                      });
                    }
                  }}
                  disabled={!isConnected || !selectedPool || approve.isPending}
                  variant={needsCaApproval ? "default" : "outline"}
                >
                  {approve.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  <ShieldCheck className="mr-2 size-4" />
                  Approve premium token
                </Button>

                <Button
                  onClick={async () => {
                    if (!selectedPool) return;
                    try {
                      await ensureArbitrum();
                      approve.writeContract({
                        address: selectedPool.swapToken.address,
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
                  variant={needsCstApproval ? "default" : "outline"}
                >
                  {approve.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  <ShieldCheck className="mr-2 size-4" />
                  Approve cover token
                </Button>

                <Button
                  onClick={() => postAsk.mutate()}
                  disabled={
                    !isConnected ||
                    !selectedPool ||
                    postAsk.isPending ||
                    Number(size) <= 0 ||
                    Number(premium) <= 0 ||
                    Number(durationMinutes) <= 0
                  }
                >
                  {postAsk.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  <Upload className="mr-2 size-4" />
                  Post cover offer
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

              {(approve.error || postAsk.error) && (
                <div className="rounded-[var(--radius-brand)] border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  {approve.error && <p>Approve error: {approve.error.message}</p>}
                  {postAsk.error && <p>Post offer error: {postAsk.error.message}</p>}
                </div>
              )}
            </CardContent>
          </Card>

          {(lastCancelTx || lastLiftTx) && (
            <Card className="border-success/30 bg-success/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="size-4" />
                  Recent transactions
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {lastCancelTx && (
                  <a
                    href={arbiscanTx(lastCancelTx)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 font-mono text-xs text-accent-on-dark hover:underline"
                  >
                    <ExternalLink className="size-3" />
                    Cancelled offer · {truncate(lastCancelTx)}
                  </a>
                )}
                {lastLiftTx && (
                  <a
                    href={arbiscanTx(lastLiftTx)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 font-mono text-xs text-accent-on-dark hover:underline"
                  >
                    <ExternalLink className="size-3" />
                    Filled request · {truncate(lastLiftTx)}
                  </a>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Inbox className="size-5" />
                Open cover requests
              </CardTitle>
              <CardDescription>
                Existing requests from buyers. Lift one to provide cover just-in-time and earn the premium.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {bidsLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (openBids ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No open cover requests on this pool right now.
                  <br />
                  <span className="text-xs">You can still post your own cover offer above.</span>
                </p>
              ) : (
                <div className="space-y-3">
                  {(openBids ?? []).map((bid) => {
                    const makerAllowance = bidAllowances?.[bid.orderHash] ?? undefined;
                    const makingAmount = bid.makingAmount ? BigInt(bid.makingAmount) : 0n;
                    const makerApproved = makerAllowance !== undefined && makerAllowance >= makingAmount;
                    const isLifting = liftingOrderHash === bid.orderHash;
                    return (
                      <div
                        key={bid.orderHash}
                        className="flex flex-col gap-2 rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <Badge variant="outline">Request</Badge>
                            <span className="font-mono">{bid.premium} bps premium</span>
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {truncate(bid.orderHash)} · {truncate(bid.maker)}
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            Paying{" "}
                            {bid.makingAmount
                              ? formatUnits(BigInt(bid.makingAmount), selectedPool?.collateralToken.decimals ?? 18)
                              : "—"}{" "}
                            {selectedPool?.collateralToken.symbol} for{" "}
                            {bid.takingAmount
                              ? formatUnits(BigInt(bid.takingAmount), selectedPool?.swapToken.decimals ?? 18)
                              : "—"}{" "}
                            cover
                          </div>
                          {makerAllowance !== undefined && !makerApproved && (
                            <div className="font-mono text-[10px] text-danger">
                              Maker has not approved enough {selectedPool?.collateralToken.symbol} to 1inch.
                            </div>
                          )}
                        </div>
                        <Button
                          size="sm"
                          disabled={!isConnected || isLifting || liftReceipt.isLoading || !makerApproved}
                          onClick={() => liftBid(bid)}
                        >
                          {isLifting && <Loader2 className="mr-2 size-4 animate-spin" />}
                          Lift request
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {lift.error && (
            <div className="rounded-[var(--radius-brand)] border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <p className="font-medium">Fill error</p>
              <p>{lift.error.message}</p>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wallet className="size-5" />
                Your open cover offers
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!isConnected ? (
                <p className="text-sm text-muted-foreground">Connect your wallet to see your offers.</p>
              ) : ordersLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (myOrders ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No open cover offers from {truncate(address)} on this pool.
                  <br />
                  <span className="text-xs">Filled or expired orders are no longer listed.</span>
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
                          Making {order.makingAmount} / Taking {order.takingAmount}
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
                Bond terms
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
                Post an offer at or below Bond&apos;s floor to stay competitive. Just-in-time minting creates cover tokens inside the fill, so you do not need them in your wallet upfront.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="size-5" />
                Pricing heuristic
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
                  <span className="text-muted-foreground">Risk score</span>
                  <span className="font-mono font-medium text-success">42/100 — Low</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full bg-success transition-all" style={{ width: "42%" }} />
                </div>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Floor</span>
                <span className="font-mono">{formatBps(bondStatus?.floorPremiumBps ?? 0)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Target ask</span>
                <span className="font-mono">{formatBps((bondStatus?.floorPremiumBps ?? 0) + (bondStatus?.counterMarginBps ?? 0))}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
