import { Hex } from "viem";

export interface TokenMeta {
  address: Hex;
  name: string;
  symbol: string;
  decimals: number;
}

export interface PhoenixPool {
  chainId: number;
  poolId: string;
  poolName: string;
  expiry: string;
  deploymentTxHash: Hex;
  poolManagerAddress: Hex;
  collateralToken: TokenMeta;
  referenceToken: TokenMeta;
  principalToken: TokenMeta;
  swapToken: TokenMeta;
  isWhitelistEnabled: boolean;
  isDepositPaused: boolean;
  isWithdrawPaused: boolean;
  isSwapPaused: boolean;
  tvl: { inUsdAtNow: number };
  collateralValue: { inWei: string; inToken: number };
}

// Note: the Phoenix /orderbook endpoint uses makerAsset/takerAsset naming,
// while /fills uses makingAsset/takingAsset. LimitOrder mirrors orderbook.
export interface LimitOrder {
  orderHash: Hex;
  chainId: number;
  poolId: string;
  maker: Hex;
  side: "BUY" | "SELL";
  makerAsset: Hex;
  takerAsset: Hex;
  makingAmount: string;
  takingAmount: string;
  remainingMakingAmount: string;
  remainingTakingAmount: string;
  premium: number;
  expiry: number;
  status: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "EXPIRED";
  salt: string;
  makerTraits: string;
  signature: Hex;
  extension: Hex;
  makerAccountType: "EOA" | "CONTRACT";
  nonce: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Fill {
  orderHash: Hex;
  chainId: number;
  poolId: string;
  txHash: Hex;
  blockNumber: string;
  blockTimestamp: string;
  logIndex: number;
  maker: Hex;
  taker: Hex;
  makingAsset: Hex;
  takingAsset: Hex;
  makingAmount: string;
  takingAmount: string;
  isPartialFill: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrderbookResponse {
  bids: LimitOrder[];
  asks: LimitOrder[];
}

export interface SafeOrderResponse {
  orders: LimitOrder[];
}

export interface PostBidRequest {
  poolId: Hex;
  ca: Hex;
  cst: Hex;
  caDecimals: number;
  sizeCst: string;
  priceCaPerCst: number;
  premiumDisplay?: number;
  expirySeconds?: number;
}

export interface PostBidResponse {
  orderHash: Hex;
  signature: Hex;
}

export interface CancelOrderRequest {
  salt: string;
  maker: Hex;
  receiver: Hex;
  makerAsset: Hex;
  takerAsset: Hex;
  makingAmount: string;
  takingAmount: string;
  makerTraits: string;
}

export interface CancelOrderResponse {
  userOpHash: Hex;
  txHash?: Hex;
}

export interface BondDecision {
  poolId: string;
  orderHash?: Hex;
  action: string;
  reason: string;
  txHash?: Hex;
  postedOrderHash?: Hex;
}

export interface BondStatus {
  bondAddress: Hex;
  caToken: Hex;
  refToken: Hex;
  caDecimals: number;
  refDecimals: number;
  floorPremiumBps: number;
  counterMarginBps: number;
  maxCaPosition: string;
  chainId: number;
  blockTimestamp: number;
  utilizationBps: number;
  recentDecisions: BondDecision[];
}

export interface BondPoolPosition {
  poolId: Hex;
  cst: Hex;
  cpt: Hex;
  cstBalance: string;
  cptBalance: string;
}

export interface BondPosition {
  bondAddress: Hex;
  caBalance: string;
  refBalance: string;
  caLockedInOpenOrders: string;
  caAtRiskFromFills: string;
  caExposure: string;
  maxCaPosition: string;
  utilizationBps: number;
  pools: Record<string, BondPoolPosition>;
  fills: Fill[];
}

export interface PortfolioPoint {
  date: string;
  value: number;
}

export interface YieldPoint {
  term: string;
  apy: number;
}

export interface ExposurePoint {
  asset: string;
  value: number;
}

export interface RiskScore {
  poolId: string;
  score: number;
  label: string;
}

export interface AnalyticsKpis {
  lossRatio: number;
  activeMarkets: number;
  utilization: number;
  annualizedYield: number;
}

export interface AnalyticsData {
  portfolioHistory: PortfolioPoint[];
  yieldCurve: YieldPoint[];
  exposureByRef: ExposurePoint[];
  riskScores: RiskScore[];
  kpis: AnalyticsKpis;
}
