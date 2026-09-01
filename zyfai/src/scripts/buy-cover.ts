/**
 * One-shot demand-side cST buy through Zyfai's CorkForSelfAdapter.
 *
 *   orderbook → decode → prepare(--for-self) → batch pre-flight → sendGuardedBatch → reconcile
 *
 * Usage:
 *   npm run buy:cover -- --pool-id 0x… --amount <cST-base-units> [--dry-run]
 *
 * Prereqs:
 *   - `ch` on PATH (or CH_BIN pointing at cork-cli's binstub).
 *   - CORK_FOR_SELF_ADAPTER set (Zyfai's deployed adapter).
 *   - CORK_RPC_URL or BASE_RPC_URL set.
 *   - Safe already provisioned (`provision:account`) with the session key + GUARD_MODULE.
 *   - TargetRegistry whitelisted for (adapter, fillOrderForSelf) and (CA, approve, adapter).
 *
 * Runtime path is fully typed through `services/cork-cli.ts`; this script is the
 * orchestration layer. Errors bubble as typed CorkError subclasses.
 */
import { encodeFunctionData, erc20Abi } from 'viem';
import type { Address, Hex } from 'viem';

import { env } from '../config/env.js';
import {
  decodeOrder,
  prepareFillForSelf,
  queryOrderbook,
  trackReconcile,
  trackSimulate,
  CorkError,
  CorkConflictError,
  CorkUnavailableError,
  type Approval,
  type Order,
} from '../services/cork-cli.js';
import { createSessionContext, GUARDED_BATCH_SIM_ABI, type Execution } from '../services/session.js';

function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

function isHex40(s: string): s is Address {
  return /^0x[a-fA-F0-9]{40}$/u.test(s);
}

function isHex(s: string): s is Hex {
  return /^0x[a-fA-F0-9]+$/u.test(s);
}

function parseArgs(argv: string[]): { poolId: Hex; amount: string; dryRun: boolean } {
  let poolId: string | undefined;
  let amount: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--pool-id') {
      poolId = argv[++i];
      continue;
    }
    if (arg === '--amount') {
      amount = argv[++i];
      continue;
    }
    fail(`unknown arg "${arg}" — usage: --pool-id 0x… --amount <cST-base-units> [--dry-run]`);
  }

  if (!poolId || !isHex(poolId) || poolId.length !== 66) {
    fail('--pool-id is required (0x-prefixed 32-byte hex)');
  }
  if (!amount || !/^[0-9]+$/u.test(amount)) {
    fail('--amount is required (decimal base-unit string of cST to buy)');
  }
  return { poolId: poolId as Hex, amount, dryRun };
}

function asBigInt(value: string | number | undefined, fallback = 0n): bigint {
  if (value === undefined) return fallback;
  return BigInt(value);
}

function pickSellOrder(orders: readonly Order[], amount: bigint): Order {
  if (orders.length === 0) {
    fail('orderbook returned no items — no resting asks for this poolId (Base pre-first-market? coordinate with bond.credit)');
  }

  const open = new Set(['OPEN', 'PARTIALLY_FILLED', 'open', 'partially_filled']);

  const fillable = (order: Order): boolean => {
    const side = (order.side ?? 'SELL').toUpperCase();
    if (side !== 'SELL') return false;
    if (order.status && !open.has(order.status)) return false;
    const remaining = asBigInt(order.remainingMakingAmount, asBigInt(order.makingAmount));
    return remaining >= amount;
  };

  // Hybrid-mode rows are chain-verified against the LOP invalidator: refuted
  // rows never reach us, "confirmed" is chain-live, "unverified" is
  // indeterminate (verification budget / transport). Prefer confirmed; take an
  // unverified row only when no confirmed one fits — the prepare's own
  // liveness pre-flight is the backstop either way.
  const confirmed = orders.find((o) => o.verification !== 'unverified' && fillable(o));
  if (confirmed) return confirmed;

  const unverified = orders.find(fillable);
  if (unverified) {
    console.warn(
      `  ! picking a verification=unverified row (${unverified.orderHash}) — no confirmed row fits; ` +
        'the venue reported it but the chain check was indeterminate. The prepare liveness pre-flight decides.',
    );
    return unverified;
  }

  fail(
    `no OPEN/PARTIALLY_FILLED SELL with remainingMakingAmount >= ${amount.toString()} — ` +
      'wait for underwriter liquidity, post an RFQ, or lower --amount',
  );
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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
function approvalExecution(
  ap: Approval,
  adapter: Address,
  order: Order,
  takingCap: bigint,
): Execution {
  if (!sameAddress(ap.spender, adapter)) {
    fail(
      `approvals[] entry (${ap.tokenRole}) names spender ${ap.spender} != our adapter ${adapter} — REFUSE (safety)`,
    );
  }
  if (!sameAddress(ap.token, order.takerAsset)) {
    fail(
      `cannot vet approval for ${ap.tokenRole} (${ap.token}) — ` +
        'only the taker-asset (CA premium) grant is expected on a fill; inspect the artifact',
    );
  }
  if (BigInt(ap.amount) !== takingCap) {
    fail(
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

async function main(): Promise<void> {
  const { poolId, amount, dryRun } = parseArgs(process.argv.slice(2));
  const amountBn = BigInt(amount);

  if (!env.CORK_FOR_SELF_ADAPTER) fail('CORK_FOR_SELF_ADAPTER is required (deploy the adapter first)');
  const adapter = env.CORK_FOR_SELF_ADAPTER as Address;

  const rpcUrl = env.CORK_RPC_URL ?? env.BASE_RPC_URL ?? env.ALCHEMY_RPC_URL;
  if (!rpcUrl) fail('CORK_RPC_URL (or BASE_RPC_URL / ALCHEMY_RPC_URL) is required');

  const ctx = await createSessionContext({ chainId: env.CORK_CHAIN_ID, rpcUrl });
  console.log(`chain   : ${ctx.chain.name} (${ctx.chain.id})`);
  console.log(`safe    : ${ctx.safeAddress}`);
  console.log(`adapter : ${adapter}`);
  console.log(`poolId  : ${poolId}`);
  console.log(`amount  : ${amount} cST base units`);
  if (dryRun) console.log('mode    : --dry-run (stops after the batch pre-flight)');
  console.log('');

  // Step 1 — find a resting SELL big enough
  const orders = await queryOrderbook(env.CORK_CHAIN_ID, poolId);
  const order = pickSellOrder(orders, amountBn);
  const remaining = asBigInt(order.remainingMakingAmount, asBigInt(order.makingAmount));
  console.log(`order   : ${order.orderHash}`);
  console.log(`remain  : ${remaining.toString()} cST available`);

  // 1inch bit-invalidator: one fill of ANY size can consume the whole order (unless the maker
  // opted into partial+multiple fills). Read the maker's traits before sizing; sizing below
  // remaining forfeits the rest.
  if (amountBn < remaining) {
    console.warn(
      `  ! bit-invalidator: filling ${amount} of ${remaining.toString()} may consume the whole order — ` +
        'the rest becomes DEAD (see cork-periphery README §Known limitations).',
    );
  }

  // Step 2 — decode + sanity-check the adapter binding
  const decoded = await decodeOrder(env.CORK_CHAIN_ID, order);
  // A plain LOP order (extension 0x) decodes with no `jit` block at all — that
  // is a legitimate book row, but not the shape our --for-self cover buy expects.
  if (!decoded.jit) {
    fail('order carries no Cork JIT extension — not a taker-cover-buy order');
  }
  console.log(`recipe  : ${decoded.jit.recipe} (${decoded.jit.generation})`);
  console.log(`jit adap: ${decoded.jit.adapter}`);
  // The order's own `adapter` (the JIT LOP adapter, not OUR adapter) is a protocol address —
  // we do not assert it matches ours. What we assert is that the order carries a live JIT recipe
  // and enables jit-mint, which is the shape our --for-self fill expects.
  if (!decoded.jit.enableJitMint) {
    fail('order does not enable JIT mint — not a taker-cover-buy order');
  }

  // Step 3 — build the unsigned fill routed through OUR adapter
  const artifact = await prepareFillForSelf({
    chainId: env.CORK_CHAIN_ID,
    account: ctx.safeAddress,
    orderHash: order.orderHash,
    fillMakingAmount: amount,
    adapter,
    poolId,
    clientRequestId: `buy-${Date.now()}`,
  });

  // Safety: the artifact's adapter (the only spender its allowances can feed,
  // and the target of the call) must be OUR deployment.
  if (!sameAddress(artifact.forSelf.adapter, adapter) || !sameAddress(artifact.to, adapter)) {
    fail(
      `artifact adapter ${artifact.forSelf.adapter} / target ${artifact.to} != our adapter ${adapter} — REFUSE (safety)`,
    );
  }

  // The taker-asset cap the CLI signs the fill against: the exact rounded-up
  // signed ratio (takingAmount * fill / makingAmount, ceiling division). We
  // compute it independently and require the artifact to agree.
  const makingFull = asBigInt(order.makingAmount, asBigInt(order.remainingMakingAmount));
  const takingFull = asBigInt(order.takingAmount, asBigInt(order.remainingTakingAmount));
  if (makingFull === 0n) fail('order has no makingAmount — cannot size the premium cap');
  if (takingFull === 0n) fail('order has no takingAmount — cannot size the premium cap');
  const takingCap = (takingFull * amountBn + makingFull - 1n) / makingFull;
  console.log(`premium : cap ${takingCap.toString()} base units of ${order.takerAsset} (CA)`);

  if (artifact.auction) {
    // A decaying auction prices the fill ABOVE the signed ratio until decay
    // completes, so the signed-ratio cap computed here would under-approve and
    // the fill would revert. Size the approval from the auction ceiling before
    // wiring this path.
    fail(
      `DECAYING AUCTION order — this script sizes the premium approval from the signed ratio, ` +
        `which is below the live auction price ` +
        `(current=${artifact.auction.current}, ceiling=${artifact.auction.ceiling}, floor=${artifact.auction.floor}). ` +
        'Pick a non-auction order, or extend approvalExecution to cap at the auction ceiling.',
    );
  }

  // Cross-check the artifact's own sizing against the signed order.
  if (artifact.requiredTakingAmount !== undefined && BigInt(artifact.requiredTakingAmount) !== takingCap) {
    fail(
      `artifact requiredTakingAmount ${artifact.requiredTakingAmount} != our signed-ratio cap ${takingCap.toString()} — ` +
        'the CLI prices this fill differently than the signed order row we vetted; REFUSE',
    );
  }

  // Step 4 — the batch: the grants the artifact states (vetted entry by
  // entry), then the single adapter call.
  const approvals = artifact.approvals ?? [];
  if (approvals.length === 0) {
    fail('artifact carries no approvals[] — cannot vet the grants this fill needs; inspect the artifact');
  }
  for (const ap of approvals) {
    console.log(`  approve ${ap.token} → ${ap.spender} (${ap.kind} ${ap.amount}, ${ap.tokenRole}${ap.satisfied ? ', already satisfied' : ''})`);
  }
  const executions: Execution[] = [
    ...approvals.map((ap) => approvalExecution(ap, adapter, order, takingCap)),
    { target: artifact.to, value: asBigInt(artifact.value), callData: artifact.calldata },
  ];

  // Step 5a — advisory: simulate the lone adapter call. It CANNOT pass until
  // the CA allowance exists, and ours is granted inside the same batch — so a
  // revert here is expected on a first buy; the batch pre-flight below is the
  // authoritative gate.
  const sim = await trackSimulate(env.CORK_CHAIN_ID, artifact);
  if (sim.wouldRevert) {
    console.warn(
      `  ! artifact-only simulate reverts (${sim.revertReason ?? 'no reason'}) — ` +
        'expected when the premium allowance is granted in-batch; deciding on the batch pre-flight.',
    );
  } else {
    console.log('sim     : ok, wouldRevert=false (allowance already in place)');
  }

  // Step 5b — authoritative pre-flight: eth_call the FULL guarded batch
  // (approvals + fill, atomically) at current state; REQUIRE it not to revert.
  try {
    await ctx.publicClient.simulateContract({
      address: ctx.guardModule,
      abi: GUARDED_BATCH_SIM_ABI,
      functionName: 'executeGuardedBatch',
      args: [executions],
      account: ctx.safeAddress,
    });
    console.log('batch   : pre-flight ok (approvals + fill do not revert)');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`batch pre-flight reverted — nothing was sent.\n${message}`);
  }

  if (dryRun) {
    console.log('\ndry-run stops here. Remove --dry-run to broadcast.');
    return;
  }

  // Step 6 — sign + broadcast via Rhinestone intent through the GUARD_MODULE
  console.log(`\nbroadcasting ${executions.length} exec(s) through GUARD_MODULE.executeGuardedBatch…`);
  const result = await ctx.sendGuardedBatch(executions);
  console.log(`tx      : ${result.transactionHash}`);
  if (result.intentId) console.log(`intent  : ${result.intentId}`);
  if (result.blockNumber !== undefined) console.log(`block   : ${result.blockNumber.toString()}`);
  console.log(`success : ${result.success}`);

  // Step 7 — reconcile chain vs venue index
  try {
    await trackReconcile(env.CORK_CHAIN_ID, order.orderHash, result.transactionHash);
    console.log('reconc  : ok');
  } catch (error) {
    if (error instanceof CorkConflictError) {
      console.error(`reconc  : CONFLICT — chain vs venue disagreement, do NOT retry: ${error.message}`);
    } else if (error instanceof CorkUnavailableError) {
      console.warn(`reconc  : unavailable (${error.code}) — chain state is authoritative`);
    } else {
      console.warn(`reconc  : soft-fail — ${(error as Error).message}`);
    }
  }

  console.log('\nDone.');
}

main().catch((error: unknown) => {
  if (error instanceof CorkConflictError) {
    console.error(`\nFAILED (conflict — do NOT retry): ${error.message}`);
    process.exit(3);
  }
  if (error instanceof CorkUnavailableError) {
    console.error(`\nUNAVAILABLE (${error.code}): ${error.message}`);
    process.exit(2);
  }
  if (error instanceof CorkError) {
    console.error(`\ncork-cli error (${error.name}): ${error.message}`);
    process.exit(2);
  }
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`\nFAILED: ${detail}`);
  process.exit(1);
});
