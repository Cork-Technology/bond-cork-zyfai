import type {
  AnalyticsData,
  PortfolioPoint,
  YieldPoint,
  ExposurePoint,
  RiskScore,
} from "@/lib/types";

function cyrb128(str: string): number {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return (h1 ^ h2 ^ h3 ^ h4) >>> 0;
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getMockAnalytics(
  realPosition?: { caAtRisk: number; premiumEarned: number; maxPosition: number }
): AnalyticsData {
  const seed = cyrb128(
    realPosition
      ? `${realPosition.caAtRisk}-${realPosition.premiumEarned}`
      : "bond-cork-zyfai-analytics"
  );
  const rand = mulberry32(seed);

  const lastValue = realPosition
    ? realPosition.caAtRisk + realPosition.premiumEarned
    : 1_000_000 + Math.round(rand() * 500_000);

  const startValue = lastValue * (0.85 + rand() * 0.1);
  const days = 30;
  const portfolioHistory: PortfolioPoint[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const progress = (days - 1 - i) / (days - 1);
    const value =
      startValue + (lastValue - startValue) * progress + (rand() - 0.5) * lastValue * 0.02;
    portfolioHistory.push({
      date: d.toISOString().slice(0, 10),
      value: Math.max(0, Number(value.toFixed(2))),
    });
  }

  const yieldCurve: YieldPoint[] = [
    { term: "7d", apy: Number((3 + rand() * 4).toFixed(2)) },
    { term: "30d", apy: Number((6 + rand() * 5).toFixed(2)) },
    { term: "90d", apy: Number((9 + rand() * 6).toFixed(2)) },
  ];

  const exposureByRef: ExposurePoint[] = [
    { asset: "USDC", value: Math.round(300_000 + rand() * 200_000) },
    { asset: "sUSDe", value: Math.round(250_000 + rand() * 250_000) },
    { asset: "yoUSD", value: Math.round(150_000 + rand() * 150_000) },
  ];

  const riskScores: RiskScore[] = [
    {
      poolId: "0xcc6e...a50d4",
      score: Math.round(20 + rand() * 30),
      label: "Low",
    },
    {
      poolId: "0xc0ba...8dd1a",
      score: Math.round(40 + rand() * 30),
      label: "Medium",
    },
  ];

  const kpis = {
    lossRatio: Number((rand() * 0.08).toFixed(4)),
    activeMarkets: 2,
    utilization: Number((0.55 + rand() * 0.35).toFixed(4)),
    annualizedYield: Number((yieldCurve[1].apy + rand() * 2).toFixed(2)),
  };

  return {
    portfolioHistory,
    yieldCurve,
    exposureByRef,
    riskScores,
    kpis,
  };
}
