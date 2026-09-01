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
} from '../services/cork-cli.js';
import {
  approvalExecution,
  asBigInt,
  pickSellOrder,
  sameAddress,
  signedRatioCap,
} from '../services/order-vetting.js';
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

// Order selection, cap math and grant vetting live in services/order-vetting.ts
// (pure, unit-tested); a RefusalError thrown there reaches the catch at the
// bottom and exits 1 with the same FAILED line fail() prints.

async function main(): Promise<void> {
  const { poolId, amount, dryRun } = parseArgs(process.argv.slice(2));
  const amountBn = BigInt(amount);

  if (!env.CORK_FOR_SELF_ADAPTER || !isHex40(env.CORK_FOR_SELF_ADAPTER)) {
    fail('CORK_FOR_SELF_ADAPTER must be a 0x-prefixed 20-byte address (deploy the adapter first)');
  }
  const adapter: Address = env.CORK_FOR_SELF_ADAPTER;

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

  // The taker-asset cap the CLI signs the fill against, computed independently
  // from the order row so the artifact can be required to agree with it.
  const takingCap = signedRatioCap(order, amountBn);
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
