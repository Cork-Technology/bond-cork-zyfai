"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, parseUnits } from "viem";
import Link from "next/link";
import { fetchBondStatus } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FALLBACK_POOLS, KNOWN_POOLS, arbiscanTx } from "@/lib/constants";
import { cn, truncate } from "@/lib/utils";
import { NegotiationFeed } from "@/components/negotiation-feed";
import {
  ShieldCheck,
  AlertTriangle,
  HandCoins,
  CheckCircle2,
  ArrowRight,
  RefreshCw,
  TrendingUp,
  Wallet,
  FileSignature,
} from "lucide-react";

const POOL = FALLBACK_POOLS.find((p) => p.poolId === KNOWN_POOLS.sUSDe_yoUSD)!;
const DEMO_FILL_TX = "0x299902c95a0c262f3c0744bb3f2d4d3b672b543012d2305dcf449842a6306eed";

function formatBps(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

function premiumCa(sizeCst: bigint, premiumPerCst: number, caDecimals: number): bigint {
  const PRICE_SCALE = 1_000_000_000n;
  const priceScaled = BigInt(Math.round(premiumPerCst * 1e9));
  return (
    (sizeCst * priceScaled * 10n ** BigInt(caDecimals) + (PRICE_SCALE * 10n ** 18n - 1n)) /
    (PRICE_SCALE * 10n ** 18n)
  );
}

export default function WorkflowPage() {
  const { data: bondStatus } = useQuery({
    queryKey: ["bond-status"],
    queryFn: fetchBondStatus,
  });

  const floorBps = bondStatus?.floorPremiumBps ?? 50;
  const marginBps = bondStatus?.counterMarginBps ?? 10;

  const [step, setStep] = useState<
    | "request"
    | "analyzing"
    | "offer"
    | "counter"
    | "reoffer"
    | "accept"
    | "done"
  >("request");

  const [positionSize, setPositionSize] = useState<string>("1000");
  const [zyfaiBidPremium, setZyfaiBidPremium] = useState<string>("0.05");
  const [bondAskPremium, setBondAskPremium] = useState<string>("0.06");
  const [counterPremium, setCounterPremium] = useState<string>("0.055");
  const [finalPremium, setFinalPremium] = useState<string>("0.055");

  const sizeNum = Number(positionSize) || 0;
  const sizeCst = useMemo(
    () => (sizeNum > 0 ? parseUnits(positionSize, POOL.swapToken.decimals) : 0n),
    [positionSize]
  );

  const bidPremiumCa = useMemo(
    () =>
      sizeNum > 0
        ? premiumCa(sizeCst, Number(zyfaiBidPremium), POOL.collateralToken.decimals)
        : 0n,
    [sizeCst, zyfaiBidPremium]
  );

  const askPremiumCa = useMemo(
    () =>
      sizeNum > 0
        ? premiumCa(sizeCst, Number(bondAskPremium), POOL.collateralToken.decimals)
        : 0n,
    [sizeCst, bondAskPremium]
  );

  const finalPremiumCa = useMemo(
    () =>
      sizeNum > 0
        ? premiumCa(sizeCst, Number(finalPremium), POOL.collateralToken.decimals)
        : 0n,
    [sizeCst, finalPremium]
  );

  const bidBps = sizeNum > 0 ? Math.round((Number(zyfaiBidPremium) / sizeNum) * 10000) : 0;
  const askBps = sizeNum > 0 ? Math.round((Number(bondAskPremium) / sizeNum) * 10000) : 0;
  const counterBps = sizeNum > 0 ? Math.round((Number(counterPremium) / sizeNum) * 10000) : 0;
  const finalBps = sizeNum > 0 ? Math.round((Number(finalPremium) / sizeNum) * 10000) : 0;

  const riskScore = 42;
  const riskLabel = riskScore < 50 ? "Low" : riskScore < 75 ? "Medium" : "High";

  const reset = () => {
    setStep("request");
    setPositionSize("1000");
    setZyfaiBidPremium("0.05");
    setBondAskPremium("0.06");
    setCounterPremium("0.055");
    setFinalPremium("0.055");
  };

  const stepState = (target: typeof step) => {
    const order = ["request", "analyzing", "offer", "counter", "reoffer", "accept", "done"];
    const current = order.indexOf(step);
    const t = order.indexOf(target);
    if (t < current) return "completed";
    if (t === current) return "active";
    return "pending";
  };

  const feedEvents = useMemo(() => {
    const events: Parameters<typeof NegotiationFeed>[0]["events"] = [];
    events.push({
      actor: "ZYFAI",
      action: "REQUEST COVER",
      detail: `${positionSize} ${POOL.referenceToken.symbol} @ ${bidBps} bps`,
      status: stepState("request") === "completed" || stepState("request") === "active" ? "done" : "pending",
    });
    if (stepState("analyzing") !== "pending") {
      events.push({
        actor: "BOND",
        action: "ANALYZE RISK",
        detail: `score ${riskScore}/100 — ${riskLabel}`,
        status: "done",
      });
    }
    if (stepState("offer") !== "pending") {
      events.push({
        actor: "BOND",
        action: "SEND OFFER",
        detail: `${positionSize} ${POOL.referenceToken.symbol} @ ${askBps} bps`,
        status: stepState("offer") === "active" ? "counter" : "done",
      });
    }
    if (stepState("counter") !== "pending") {
      events.push({
        actor: "ZYFAI",
        action: "COUNTER OFFER",
        detail: `${positionSize} ${POOL.referenceToken.symbol} @ ${counterBps} bps`,
        status: "counter",
      });
    }
    if (stepState("reoffer") !== "pending") {
      events.push({
        actor: "BOND",
        action: "RE-EVALUATE & OFFER",
        detail: `${positionSize} ${POOL.referenceToken.symbol} @ ${finalBps} bps`,
        status: stepState("reoffer") === "active" ? "counter" : "done",
      });
    }
    if (step === "accept" || step === "done") {
      events.push({
        actor: "ZYFAI",
        action: "ACCEPT OFFER",
        detail: `${formatUnits(finalPremiumCa, POOL.collateralToken.decimals)} ${POOL.collateralToken.symbol}`,
        status: "counter",
      });
    }
    if (step === "done") {
      events.push({
        actor: "BOND",
        action: "SETTLED ON-CHAIN",
        detail: `tx ${truncate(DEMO_FILL_TX)}`,
        txHash: DEMO_FILL_TX,
        status: "done",
      });
    }
    return events;
  }, [step, positionSize, bidBps, askBps, counterBps, finalBps, finalPremiumCa, riskScore, riskLabel]);

  const StepHeader = ({
    n,
    icon: Icon,
    title,
    status,
  }: {
    n: number;
    icon: React.ElementType;
    title: string;
    status: "completed" | "active" | "pending";
  }) => (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-brand)] border font-mono text-xs",
          status === "active"
            ? "border-blue-action bg-blue-action text-white"
            : status === "completed"
            ? "border-success/50 bg-success/10 text-success"
            : "border-[var(--hairline-dark)] bg-surface-2 text-muted-foreground"
        )}
      >
        {status === "completed" ? <CheckCircle2 className="size-4" /> : n}
      </div>
      <div>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </div>
    </div>
  );

  const SummaryRow = ({
    label,
    value,
    highlight = false,
  }: {
    label: string;
    value: string;
    highlight?: boolean;
  }) => (
    <div className="flex justify-between">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xs", highlight && "text-accent-on-dark")}>{value}</span>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          // WORKFLOW
        </span>
        <h1 className="font-display text-3xl font-bold tracking-tight text-foreground">
          How the insurance deal works
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Zyfai requests cover on a position, Bond prices the risk, they negotiate, and the deal settles on-chain.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{POOL.collateralToken.symbol} / {POOL.referenceToken.symbol}</Badge>
        <Badge variant="outline">Floor {formatBps(floorBps)}</Badge>
        <Badge variant="outline">Bond margin {formatBps(marginBps)}</Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* Step 1: Zyfai requests insurance */}
          <Card className={cn("border-l-4", stepState("request") === "active" ? "border-l-blue-action" : "border-l-transparent")}>
            <CardHeader>
              <StepHeader n={1} icon={Wallet} title="Zyfai requests insurance for position X" status={stepState("request")} />
              <CardDescription>
                Zyfai has a {POOL.referenceToken.symbol} position and wants depeg cover.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-mono text-[10px] uppercase tracking-wider">Position size</Label>
                  <Input
                    type="number"
                    value={positionSize}
                    onChange={(e) => setPositionSize(e.target.value)}
                    disabled={step !== "request"}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="font-mono text-[10px] uppercase tracking-wider">Max premium per unit ({POOL.collateralToken.symbol})</Label>
                  <Input
                    type="number"
                    step="0.001"
                    value={zyfaiBidPremium}
                    onChange={(e) => setZyfaiBidPremium(e.target.value)}
                    disabled={step !== "request"}
                  />
                </div>
              </div>
              <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3 text-sm space-y-1">
                <SummaryRow label="Cover requested" value={`${positionSize} cover units`} />
                <SummaryRow label="Implied premium" value={sizeNum > 0 ? `${bidBps} bps` : "—"} />
                <SummaryRow
                  label="Total premium offered"
                  value={
                    bidPremiumCa > 0n
                      ? `${formatUnits(bidPremiumCa, POOL.collateralToken.decimals)} ${POOL.collateralToken.symbol}`
                      : "—"
                  }
                />
              </div>
              {step === "request" && (
                <Button onClick={() => setStep("analyzing")}>
                  Create market & post cover request <ArrowRight className="ml-2 size-4" />
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Step 2: Bond analyzes */}
          <Card className={cn("border-l-4", stepState("analyzing") === "active" ? "border-l-blue-action" : "border-l-transparent")}>
            <CardHeader>
              <StepHeader n={2} icon={ShieldCheck} title="Bond analyzes the position and risk" status={stepState("analyzing")} />
              <CardDescription>
                Bond&apos;s underwriting engine scores the slice and sets a floor.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {stepState("analyzing") !== "pending" && (
                <>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Risk score</span>
                      <span className="font-mono font-medium">{riskScore}/100 — {riskLabel}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full bg-success transition-all"
                        style={{ width: `${riskScore}%` }}
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 text-sm">
                    <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3">
                      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Collateral</p>
                      <p className="font-mono font-medium">{POOL.collateralToken.symbol}</p>
                    </div>
                    <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3">
                      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Reference</p>
                      <p className="font-mono font-medium">{POOL.referenceToken.symbol}</p>
                    </div>
                    <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3">
                      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Floor premium</p>
                      <p className="font-mono font-medium">{formatBps(floorBps)}</p>
                    </div>
                    <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3">
                      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Target ask</p>
                      <p className="font-mono font-medium">{formatBps(floorBps + marginBps)}</p>
                    </div>
                  </div>
                </>
              )}
              {step === "analyzing" && (
                <Button onClick={() => setStep("offer")}>
                  Price & sign offer <ArrowRight className="ml-2 size-4" />
                </Button>
              )}
              {stepState("analyzing") === "pending" && (
                <p className="text-sm text-muted-foreground">Waiting for Zyfai&apos;s request...</p>
              )}
            </CardContent>
          </Card>

          {/* Step 3: Bond offer */}
          <Card className={cn("border-l-4", stepState("offer") === "active" ? "border-l-blue-action" : "border-l-transparent")}>
            <CardHeader>
              <StepHeader n={3} icon={FileSignature} title="Bond sends a cover offer" status={stepState("offer")} />
              <CardDescription>
                Bond posts a signed just-in-time offer to the Phoenix orderbook.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-mono text-[10px] uppercase tracking-wider">Offer premium per unit ({POOL.collateralToken.symbol})</Label>
                  <Input
                    type="number"
                    step="0.001"
                    value={bondAskPremium}
                    onChange={(e) => setBondAskPremium(e.target.value)}
                    disabled={step !== "offer"}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="font-mono text-[10px] uppercase tracking-wider">Cover amount</Label>
                  <Input value={positionSize} disabled />
                </div>
              </div>
              <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3 text-sm space-y-1">
                <SummaryRow label="Bond&apos;s offer" value={sizeNum > 0 ? `${askBps} bps` : "—"} />
                <SummaryRow
                  label="Premium Bond wants"
                  value={
                    askPremiumCa > 0n
                      ? `${formatUnits(askPremiumCa, POOL.collateralToken.decimals)} ${POOL.collateralToken.symbol}`
                      : "—"
                  }
                />
              </div>
              {step === "offer" && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setStep("counter")} variant="outline">
                    Decline offer
                  </Button>
                  <Button
                    onClick={() => {
                      setFinalPremium(bondAskPremium);
                      setStep("accept");
                    }}
                  >
                    Accept offer & get covered <ArrowRight className="ml-2 size-4" />
                  </Button>
                </div>
              )}
              {stepState("offer") === "pending" && (
                <p className="text-sm text-muted-foreground">Waiting for Bond&apos;s analysis...</p>
              )}
            </CardContent>
          </Card>

          {/* Step 4: Zyfai counter */}
          <Card className={cn("border-l-4", stepState("counter") === "active" ? "border-l-blue-action" : "border-l-transparent")}>
            <CardHeader>
              <StepHeader n={4} icon={AlertTriangle} title="Zyfai declines the offer and sends a new bid" status={stepState("counter")} />
              <CardDescription>
                Zyfai thinks the premium is too high and sends a better-priced cover request.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-mono text-[10px] uppercase tracking-wider">Counter premium per unit ({POOL.collateralToken.symbol})</Label>
                  <Input
                    type="number"
                    step="0.001"
                    value={counterPremium}
                    onChange={(e) => setCounterPremium(e.target.value)}
                    disabled={step !== "counter"}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="font-mono text-[10px] uppercase tracking-wider">Cover amount</Label>
                  <Input value={positionSize} disabled />
                </div>
              </div>
              <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3 text-sm space-y-1">
                <SummaryRow label="Zyfai&apos;s new request" value={sizeNum > 0 ? `${counterBps} bps` : "—"} />
              </div>
              {step === "counter" && (
                <Button onClick={() => setStep("reoffer")}>
                  Send new cover request <ArrowRight className="ml-2 size-4" />
                </Button>
              )}
              {stepState("counter") === "pending" && (
                <p className="text-sm text-muted-foreground">Waiting for Bond&apos;s offer...</p>
              )}
            </CardContent>
          </Card>

          {/* Step 5: Bond re-evaluates */}
          <Card className={cn("border-l-4", stepState("reoffer") === "active" ? "border-l-blue-action" : "border-l-transparent")}>
            <CardHeader>
              <StepHeader n={5} icon={RefreshCw} title="Bond re-evaluates the risk and sends a new offer" status={stepState("reoffer")} />
              <CardDescription>
                Bond checks the counter against its risk model and signs a new offer.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {stepState("reoffer") !== "pending" && (
                <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3 text-sm space-y-1">
                  <SummaryRow label="Counter premium" value={sizeNum > 0 ? `${counterBps} bps` : "—"} />
                  <SummaryRow label="Bond floor" value={formatBps(floorBps)} />
                  <SummaryRow label="Decision" value="Acceptable" highlight />
                </div>
              )}
              {step === "reoffer" && (
                <Button
                  onClick={() => {
                    setFinalPremium(counterPremium);
                    setBondAskPremium(counterPremium);
                    setStep("accept");
                  }}
                >
                  Re-price risk & send new offer <ArrowRight className="ml-2 size-4" />
                </Button>
              )}
              {stepState("reoffer") === "pending" && (
                <p className="text-sm text-muted-foreground">Waiting for Zyfai&apos;s counter...</p>
              )}
            </CardContent>
          </Card>

          {/* Step 6: Zyfai accepts */}
          <Card className={cn("border-l-4", stepState("accept") === "active" || step === "done" ? "border-l-success" : "border-l-transparent")}>
            <CardHeader>
              <StepHeader n={6} icon={HandCoins} title="Zyfai accepts the offer — you are covered" status={stepState("accept") === "pending" && step === "done" ? "completed" : stepState("accept")} />
              <CardDescription>
                Zyfai fills the offer on-chain through 1inch.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-3 text-sm space-y-1">
                <SummaryRow label="Agreed premium" value={sizeNum > 0 ? `${finalBps} bps` : "—"} />
                <SummaryRow
                  label="Premium paid"
                  value={
                    finalPremiumCa > 0n
                      ? `${formatUnits(finalPremiumCa, POOL.collateralToken.decimals)} ${POOL.collateralToken.symbol}`
                      : "—"
                  }
                />
                <SummaryRow label="Cover received" value={`${positionSize} cover units`} />
              </div>
              {step === "accept" && (
                <Button onClick={() => setStep("done")}>
                  Accept offer & get covered <ArrowRight className="ml-2 size-4" />
                </Button>
              )}
              {step === "done" && (
                <a
                  href={arbiscanTx(DEMO_FILL_TX)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 font-mono text-xs text-accent-on-dark hover:underline"
                >
                  <CheckCircle2 className="size-4 text-success" />
                  Filled — {truncate(DEMO_FILL_TX)}
                </a>
              )}
            </CardContent>
          </Card>

          {/* Done summary */}
          {step === "done" && (
            <Card className="border-success/30 bg-success/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="size-5" />
                  Covered — both sides earn
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-4 space-y-2">
                    <p className="font-display font-bold">Zyfai (demand)</p>
                    <ul className="list-inside list-disc text-sm text-muted-foreground space-y-1">
                      <li>You are covered: holds {positionSize} cover units</li>
                      <li>Earns yield on the underlying position</li>
                      <li>Protected if {POOL.referenceToken.symbol} depegs</li>
                    </ul>
                  </div>
                  <div className="rounded-[var(--radius-brand)] border border-[var(--hairline-dark)] bg-surface-2 p-4 space-y-2">
                    <p className="font-display font-bold">Bond (supply)</p>
                    <ul className="list-inside list-disc text-sm text-muted-foreground space-y-1">
                      <li>Earns {formatUnits(finalPremiumCa, POOL.collateralToken.decimals)} {POOL.collateralToken.symbol} premium</li>
                      <li>Holds principal tokens</li>
                      <li>Earns {POOL.collateralToken.symbol} yield on locked collateral</li>
                    </ul>
                  </div>
                </div>
                <Separator />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={reset}>
                    <RefreshCw className="mr-2 size-4" />
                    Run again
                  </Button>
                  <Link href="/negotiate" className={buttonVariants({ variant: "outline" })}>
                    Open Request cover page
                  </Link>
                  <Link href="/underwrite" className={buttonVariants({ variant: "outline" })}>
                    Open Provide cover page
                  </Link>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <NegotiationFeed events={feedEvents} title="Negotiation transcript" />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deal terms</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <SummaryRow label="Pool" value={`${POOL.collateralToken.symbol} / ${POOL.referenceToken.symbol}`} />
              <SummaryRow label="Floor" value={formatBps(floorBps)} />
              <SummaryRow label="Bond margin" value={formatBps(marginBps)} />
              <SummaryRow label="Position" value={`${positionSize} ${POOL.referenceToken.symbol}`} />
              <SummaryRow label="Current step" value={step.toUpperCase()} highlight />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
