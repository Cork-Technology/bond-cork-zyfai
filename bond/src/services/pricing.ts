import { env } from '../config/env.js';

export type Decision = { kind: 'LIFT_BID' } | { kind: 'COUNTER'; premiumBps: number };

const TEN_18 = 10n ** 18n;
const TEN_CA_DECIMALS = () => 10n ** BigInt(env.CA_DECIMALS);

/**
 * Convert a signed 1inch order price into an annualized premium in basis points.
 * `makingAmount` is in CA units (e.g. 6 decimals), `takingAmount` is in cST units (18 decimals).
 * A 60 bps premium on a 1 cST cover means the taker receives 0.006 CA.
 */
export function impliedPremiumBps(makingAmount: bigint, takingAmount: bigint): number {
  if (takingAmount === 0n) return 0;
  const raw = (makingAmount * 10000n * TEN_18) / (takingAmount * TEN_CA_DECIMALS());
  return Number(raw);
}

export function decide(
  bidMakingAmount: bigint,
  bidTakingAmount: bigint,
  overrides?: { floorPremiumBps?: number; counterMarginBps?: number },
): Decision {
  const floor = overrides?.floorPremiumBps ?? env.FLOOR_PREMIUM_BPS;
  const margin = overrides?.counterMarginBps ?? env.COUNTER_MARGIN_BPS;
  const premium = impliedPremiumBps(bidMakingAmount, bidTakingAmount);

  if (premium >= floor) {
    return { kind: 'LIFT_BID' };
  }
  return { kind: 'COUNTER', premiumBps: Math.min(floor + margin, 10000) };
}

/**
 * Premium CA amount for a given cST size and premium in bps.
 * `makingAmount` (cST) is 18 decimals; result is in CA decimals.
 */
export function premiumToTakingAmount(
  makingAmountCst: bigint,
  premiumBps: number,
): bigint {
  return (makingAmountCst * BigInt(premiumBps) * TEN_CA_DECIMALS()) / (10000n * TEN_18);
}
