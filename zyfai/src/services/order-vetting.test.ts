/**
 * Unit tests for the demand-side refusal rules. Addresses here are synthetic
 * by policy — this repository carries no real contract addresses. The same
 * assertions were run against real ch v0.4.1 artifacts (a live forSelf
 * taker-fill settled on a Base vnet): our encoded approve leg is byte-equal to
 * the artifact's own unsignedTx payload, and signedRatioCap equals the
 * artifact's requiredTakingAmount.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, erc20Abi } from 'viem';
import type { Address, Hex } from 'viem';

import type { Approval, Order } from './cork-cli.js';
import {
  approvalExecution,
  pickSellOrder,
  signedRatioCap,
  RefusalError,
} from './order-vetting.js';

const ADAPTER = `0x${'aa'.repeat(20)}` as Address;
const OTHER = `0x${'bb'.repeat(20)}` as Address;
const CST = `0x${'cc'.repeat(20)}` as Address;
const USD = `0x${'dd'.repeat(20)}` as Address;

function sellOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderHash: `0x${'11'.repeat(32)}` as Hex,
    side: 'SELL',
    status: 'OPEN',
    makerAsset: CST,
    takerAsset: USD,
    makingAmount: '100000000000000000000',
    takingAmount: '5000000',
    ...overrides,
  };
}

function approval(overrides: Partial<Approval> = {}): Approval {
  const amount = (overrides.amount as string | undefined) ?? '5000000';
  return {
    role: 'taker',
    stage: 'before-fill',
    holder: OTHER,
    token: USD,
    tokenRole: 'order takerAsset',
    spender: ADAPTER,
    spenderRole: 'ForSelf adapter',
    mechanism: 'erc20-approve',
    amount,
    kind: 'cap',
    unsignedTx: {
      to: USD,
      calldata: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [ADAPTER, BigInt(amount)],
      }),
      value: '0',
    },
    ...overrides,
  };
}

test('signedRatioCap: full fill equals the signed taking amount', () => {
  assert.equal(signedRatioCap(sellOrder(), 100000000000000000000n), 5000000n);
});

test('signedRatioCap: partial fill rounds the premium UP, never down', () => {
  // 5_000_000 * 33e18 / 100e18 = 1_650_000 exactly
  assert.equal(signedRatioCap(sellOrder(), 33000000000000000000n), 1650000n);
  // making 3, taking 10, fill 1 -> ceil(10/3) = 4 (floor would underpay the maker)
  assert.equal(signedRatioCap(sellOrder({ makingAmount: '3', takingAmount: '10' }), 1n), 4n);
});

test('signedRatioCap: refuses an order with no amounts to size from', () => {
  assert.throws(
    () => signedRatioCap(sellOrder({ makingAmount: undefined, remainingMakingAmount: undefined }), 1n),
    RefusalError,
  );
  assert.throws(
    () => signedRatioCap(sellOrder({ takingAmount: undefined, remainingTakingAmount: undefined }), 1n),
    RefusalError,
  );
});

test('pickSellOrder: prefers a confirmed row over an earlier unverified one', () => {
  const unverified = sellOrder({ orderHash: `0x${'22'.repeat(32)}` as Hex, verification: 'unverified' });
  const confirmed = sellOrder({ orderHash: `0x${'33'.repeat(32)}` as Hex, verification: 'confirmed' });
  const picked = pickSellOrder([unverified, confirmed], 1n, () => {});
  assert.equal(picked.orderHash, confirmed.orderHash);
});

test('pickSellOrder: falls back to an unverified row, loudly', () => {
  const unverified = sellOrder({ verification: 'unverified' });
  const warnings: string[] = [];
  const picked = pickSellOrder([unverified], 1n, (m) => warnings.push(m));
  assert.equal(picked.orderHash, unverified.orderHash);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /unverified/);
});

test('pickSellOrder: skips BUY side, non-open status, and too-small remainders', () => {
  const tooSmall = sellOrder({ orderHash: `0x${'44'.repeat(32)}` as Hex, remainingMakingAmount: '1' });
  const buy = sellOrder({ orderHash: `0x${'55'.repeat(32)}` as Hex, side: 'BUY' });
  const filled = sellOrder({ orderHash: `0x${'66'.repeat(32)}` as Hex, status: 'FILLED' });
  const good = sellOrder({ orderHash: `0x${'77'.repeat(32)}` as Hex });
  const picked = pickSellOrder([tooSmall, buy, filled, good], 2n, () => {});
  assert.equal(picked.orderHash, good.orderHash);
});

test('pickSellOrder: refuses an empty book and a book with nothing fillable', () => {
  assert.throws(() => pickSellOrder([], 1n, () => {}), RefusalError);
  assert.throws(
    () => pickSellOrder([sellOrder({ status: 'CANCELLED' })], 1n, () => {}),
    RefusalError,
  );
});

test('approvalExecution: the vetted leg is byte-equal to the approve the CLI states', () => {
  const ap = approval();
  const leg = approvalExecution(ap, ADAPTER, sellOrder(), 5000000n);
  assert.equal(leg.target, USD);
  assert.equal(leg.value, 0n);
  assert.equal(leg.callData, ap.unsignedTx.calldata);
});

test('approvalExecution: refuses a spender that is not our adapter', () => {
  assert.throws(
    () => approvalExecution(approval({ spender: OTHER }), ADAPTER, sellOrder(), 5000000n),
    /REFUSE \(safety\)/,
  );
});

test('approvalExecution: refuses a token that is not the order takerAsset', () => {
  assert.throws(
    () => approvalExecution(approval({ token: CST, unsignedTx: { to: CST, calldata: '0x' as Hex, value: '0' } }), ADAPTER, sellOrder(), 5000000n),
    RefusalError,
  );
});

test('approvalExecution: refuses a CLI amount that disagrees with the signed-ratio cap', () => {
  assert.throws(
    () => approvalExecution(approval({ amount: '5000001' }), ADAPTER, sellOrder(), 5000000n),
    /did not compute/,
  );
});
