"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  AreaChart,
  Area,
} from "recharts";
import { listFills, fetchBondStatus, fetchBondPosition } from "@/lib/api";
import { KNOWN_POOLS, arbiscanTx } from "@/lib/constants";
import { formatToken } from "@/lib/viem";
import { getMockAnalytics } from "@/lib/mock-analytics";
import { truncate } from "@/lib/utils";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, Activity, TrendingUp, ShieldCheck, BarChart3, Percent } from "lucide-react";

function formatUsd(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function formatPct(n: number) {
  return `${(n * 100).toFixed(2)}%`;
}

function KpiCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  accent?: "blue" | "green" | "muted";
}) {
  const accentClass =
    accent === "green"
      ? "text-success"
      : accent === "blue"
      ? "text-accent-on-dark"
      : "text-muted-foreground";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <Icon className="size-3" />
          {label}
        </CardDescription>
        <CardTitle className={`font-mono text-2xl font-bold ${accentClass}`}>{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

export default function AnalyticsPage() {
  const sUsdePool = KNOWN_POOLS.sUSDe_yoUSD;

  const { data: fills, isLoading: fillsLoading } = useQuery({
    queryKey: ["fills", sUsdePool],
    queryFn: () => listFills(sUsdePool),
  });

  const { data: bondStatus, isLoading: statusLoading } = useQuery({
    queryKey: ["bond-status"],
    queryFn: fetchBondStatus,
  });

  const { data: bondPosition, isLoading: positionLoading } = useQuery({
    queryKey: ["bond-position"],
    queryFn: fetchBondPosition,
  });

  const caDecimals = bondStatus?.caDecimals ?? 18;

  const realPosition = useMemo(() => {
    const caAtRisk = bondPosition
      ? Number(formatToken(BigInt(bondPosition.caAtRiskFromFills), caDecimals)) +
        Number(formatToken(BigInt(bondPosition.caLockedInOpenOrders), caDecimals))
      : 0;
    const premiumEarned = bondPosition
      ? bondPosition.fills.reduce(
          (acc, fill) => acc + Number(formatToken(BigInt(fill.makingAmount), caDecimals)),
          0
        )
      : 0;
    const maxPosition = bondPosition
      ? Number(formatToken(BigInt(bondPosition.maxCaPosition), caDecimals))
      : 0;
    return {
      caAtRisk,
      premiumEarned,
      maxPosition,
    };
  }, [bondPosition, caDecimals]);

  const analytics = useMemo(
    () => getMockAnalytics(realPosition),
    [realPosition]
  );

  const isLoading = statusLoading || positionLoading;
  const utilization = (bondPosition?.utilizationBps ?? analytics.kpis.utilization * 10000) / 10000;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            // ANALYTICS
          </span>
          <h1 className="font-display text-3xl font-bold tracking-tight text-foreground">
            Bond underwriting analytics
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Exposure, yield and recent fill activity. Real on-chain data mixed with simulated market metrics.
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 font-mono text-[10px] uppercase">
          simulated
        </Badge>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <KpiCard
            label="Total Exposure"
            value={formatUsd(realPosition.caAtRisk + analytics.kpis.activeMarkets * 100_000)}
            icon={BarChart3}
          />
          <KpiCard
            label="Premium Earned"
            value={formatUsd(realPosition.premiumEarned)}
            icon={TrendingUp}
            accent="blue"
          />
          <KpiCard
            label="Annualized APY"
            value={`${analytics.kpis.annualizedYield.toFixed(2)}%`}
            icon={Percent}
            accent="green"
          />
          <KpiCard
            label="Utilization"
            value={formatPct(utilization)}
            icon={Activity}
          />
          <KpiCard label="Loss Ratio" value={formatPct(analytics.kpis.lossRatio)} icon={ShieldCheck} />
          <KpiCard label="Active Markets" value={analytics.kpis.activeMarkets} icon={BarChart3} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                // PORTFOLIO
              </span>{" "}
              Portfolio value
            </CardTitle>
            <CardDescription>Last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={analytics.portfolioHistory}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="date" tick={{ fontSize: 12, fill: "#C5CCD4", fontFamily: "var(--font-mono)" }} />
                  <YAxis
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                    tick={{ fontSize: 12, fill: "#C5CCD4", fontFamily: "var(--font-mono)" }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--surface-1)",
                      border: "1px solid var(--hairline-dark)",
                      borderRadius: "var(--radius-brand)",
                      fontFamily: "var(--font-mono)",
                    }}
                    formatter={(value) =>
                      typeof value === "number" ? formatUsd(value) : value
                    }
                    labelFormatter={(label) => label}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="var(--accent-on-dark)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                // EXPOSURE
              </span>{" "}
              Exposure by reference asset
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.exposureByRef}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="asset" tick={{ fill: "#C5CCD4", fontFamily: "var(--font-mono)" }} />
                  <YAxis
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                    tick={{ fill: "#C5CCD4", fontFamily: "var(--font-mono)" }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--surface-1)",
                      border: "1px solid var(--hairline-dark)",
                      borderRadius: "var(--radius-brand)",
                      fontFamily: "var(--font-mono)",
                    }}
                    formatter={(value) =>
                      typeof value === "number" ? formatUsd(value) : value
                    }
                  />
                  <Bar dataKey="value" fill="var(--blue-action)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                // YIELD
              </span>{" "}
              Yield curve
            </CardTitle>
            <CardDescription>APY by term</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analytics.yieldCurve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="term" tick={{ fill: "#C5CCD4", fontFamily: "var(--font-mono)" }} />
                  <YAxis tickFormatter={(v) => `${v}%`} tick={{ fill: "#C5CCD4", fontFamily: "var(--font-mono)" }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--surface-1)",
                      border: "1px solid var(--hairline-dark)",
                      borderRadius: "var(--radius-brand)",
                      fontFamily: "var(--font-mono)",
                    }}
                    formatter={(value) =>
                      typeof value === "number" ? `${value}%` : value
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="apy"
                    stroke="var(--success)"
                    fill="var(--success)"
                    fillOpacity={0.2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                // RISK
              </span>{" "}
              Risk scores
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {analytics.riskScores.map((risk) => (
                <div key={risk.poolId} className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="font-mono text-xs text-muted-foreground">{risk.poolId}</span>
                    <span className="font-mono text-xs">{risk.score}/100 — {risk.label}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full transition-all"
                      style={{
                        width: `${risk.score}%`,
                        backgroundColor:
                          risk.score < 50 ? "var(--success)" : risk.score < 75 ? "var(--blue-action)" : "var(--danger)",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              // FILLS
            </span>{" "}
            Recent fills
          </CardTitle>
          <CardDescription>
            sUSDe-yoUSD pool on-chain fill history
          </CardDescription>
        </CardHeader>
        <CardContent>
          {fillsLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-mono text-[10px] uppercase">Tx hash</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase">Taker</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase">Making</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase">Taking</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(fills ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center text-muted-foreground"
                    >
                      No fills for sUSDe-yoUSD yet
                    </TableCell>
                  </TableRow>
                ) : (
                  fills!.map((fill) => (
                    <TableRow key={`${fill.orderHash}-${fill.txHash}`}>
                      <TableCell>
                        <a
                          href={arbiscanTx(fill.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-xs text-accent-on-dark hover:underline"
                        >
                          {truncate(fill.txHash)}
                          <ExternalLink className="size-3" />
                        </a>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{truncate(fill.taker)}</TableCell>
                      <TableCell className="font-mono text-xs">{fill.makingAmount}</TableCell>
                      <TableCell className="font-mono text-xs">{fill.takingAmount}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {new Date(fill.blockTimestamp).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
