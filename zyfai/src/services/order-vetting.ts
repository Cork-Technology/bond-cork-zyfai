/**
 * Pure order-selection and grant-vetting rules for the demand-side cover buy.
 * Extracted from scripts/buy-cover.ts so the refusal rules are unit-testable:
 * no env, no session, no subprocess — types and integer math only. Refusals
 * throw RefusalError; the calling script turns that into its FAILED exit.
 */
import { encodeFunctionData, erc20Abi } from 'viem';
import type { Address } from 'viem';

import type { Approval, Order } from './cork-cli.js';
import type { Execution } from './session.js';

/** A guard said no. The message is the operator-facing reason, verbatim. */
export class RefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusalError';
  }
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function asBigInt(value: string | number | undefined, fallback = 0n): bigint {
  if (value === undefined) return fallback;
  return BigInt(value);
}

/**
 * Pick a fillable resting SELL. Hybrid-mode rows are chain-verified against
 * the LOP invalidator: refuted rows never reach us, "confirmed" is chain-live,
 * "unverified" is indeterminate (verification budget / transport). Prefer
 * confirmed; take an unverified row only when no confirmed one fits — the
 * prepare's own liveness pre-flight is the backstop either way.
 */
export function pickSellOrder(
  orders: readonly Order[],
  amount: bigint,
  warn: (message: string) => void = console.warn,
): Order {
  if (orders.length === 0) {
    throw new RefusalError(
      'orderbook returned no items — no resting asks for this poolId (Base pre-first-market? coordinate with bond.credit)',
    );
  }

  const open = new Set(['OPEN', 'PARTIALLY_FILLED', 'open', 'partially_filled']);

  const fillable = (order: Order): boolean => {
    const side = (order.side ?? 'SELL').toUpperCase();
    if (side !== 'SELL') return false;
    if (order.status && !open.has(order.status)) return false;
    const remaining = asBigInt(order.remainingMakingAmount, asBigInt(order.makingAmount));
    return remaining >= amount;
  };

  const confirmed = orders.find((o) => o.verification !== 'unverified' && fillable(o));
  if (confirmed) return confirmed;

  const unverified = orders.find(fillable);
  if (unverified) {
    warn(
      `  ! picking a verification=unverified row (${unverified.orderHash}) — no confirmed row fits; ` +
        'the venue reported it but the chain check was indeterminate. The prepare liveness pre-flight decides.',
    );
    return unverified;
  }

  throw new RefusalError(
    `no OPEN/PARTIALLY_FILLED SELL with remainingMakingAmount >= ${amount.toString()} — ` +
      'wait for underwriter liquidity, post an RFQ, or lower --amount',
  );
}

/**
 * The taker-asset cap the CLI signs the fill against: the exact rounded-up
 * signed ratio (takingAmount * fill / makingAmount, ceiling division),
 * computed independently from the order row so the artifact can be checked
 * against it.
 */
export function signedRatioCap(order: Order, fillMakingAmount: bigint): bigint {
  const makingFull = asBigInt(order.makingAmount, asBigInt(order.remainingMakingAmount));
  const takingFull = asBigInt(order.takingAmount, asBigInt(order.remainingTakingAmount));
  if (makingFull === 0n) throw new RefusalError('order has no makingAmount — cannot size the premium cap');
  if (takingFull === 0n) throw new RefusalError('order has no takingAmount — cannot size the premium cap');
  return (takingFull * fillMakingAmount + makingFull - 1n) / makingFull;
}

/**
 * A forSelf artifact is ONE unsigned adapter call; the grants it needs come as
 * `approvals` entries (ch 0.4.x LOP prepares) carrying the unsigned approve
 * payload, sized by the CLI at the signed-ratio cap. We do not trust that
 * sizing blindly: every entry must name OUR adapter as spender, the order's
 * taker asset as token, and an amount equal to the cap we compute
 * independently from the signed order — refuse on any mismatch (a decaying
 * auction, a stale row, or a shape drift all land here, before signing).
 */
export function approvalExecution(
  ap: Approval,
  adapter: Address,
  order: Order,
  takingCap: bigint,
): Execution {
  if (!sameAddress(ap.spender, adapter)) {
    throw new RefusalError(
      `approvals[] entry (${ap.tokenRole}) names spender ${ap.spender} != our adapter ${adapter} — REFUSE (safety)`,
    );
  }
  if (!sameAddress(ap.token, order.takerAsset)) {
    throw new RefusalError(
      `cannot vet approval for ${ap.tokenRole} (${ap.token}) — ` +
        'only the taker-asset (CA premium) grant is expected on a fill; inspect the artifact',
    );
  }
  if (BigInt(ap.amount) !== takingCap) {
    throw new RefusalError(
      `CLI-sized grant ${ap.amount} != our signed-ratio cap ${takingCap.toString()} — ` +
        'the fill would settle at a price we did not compute (decaying auction, or a changed order row); REFUSE',
    );
  }
  // Build the leg ourselves from vetted fields; the artifact's unsignedTx is
  // the same bytes, but encoding locally keeps the whitelist story auditable.
  return {
    target: ap.token,
    value: 0n,
    callData: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [adapter, takingCap],
    }),
  };
}
