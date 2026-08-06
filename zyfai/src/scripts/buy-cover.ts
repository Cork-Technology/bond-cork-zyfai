/**
 * One-shot demand-side cover buy:
 *   ch query market-predict → ch query orderbook → ch prepare taker-fill → cover.ts send
 *
 * Usage:
 *   npm run buy:cover -- --amount <cST_base_units> --expiry <unix> --recipe <recipe> [--dry-run]
 *
 * Requires `ch` on PATH (or CH_BIN). Env: COVER_REF, COVER_CA, CORK_CHAIN_ID, RPC;
 * COVER_CST optional (asserted when market-predict returns corkSwapToken).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { env } from '../config/env.js';
import { createSessionContext } from '../services/session.js';

function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function parseArgs(argv: string[]): {
  amount: string;
  expiry: string;
  recipe: string;
  dryRun: boolean;
} {
  let amount: string | undefined;
  let expiry: string | undefined;
  let recipe: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--amount') {
      amount = argv[++i];
      continue;
    }
    if (arg === '--expiry') {
      expiry = argv[++i];
      continue;
    }
    if (arg === '--recipe') {
      recipe = argv[++i];
      continue;
    }
    fail(`unknown arg "${arg}" — usage: --amount <cST> --expiry <unix> --recipe <recipe> [--dry-run]`);
  }

  if (!amount || !/^[0-9]+$/u.test(amount)) {
    fail('--amount is required (decimal base-unit string of cST to buy)');
  }
  if (!expiry || !/^[0-9]+$/u.test(expiry)) {
    fail('--expiry is required (unix seconds)');
  }
  if (!recipe) {
    fail('--recipe is required');
  }

  return { amount, expiry, recipe, dryRun };
}

/** Unwrap `{ state, data }` envelopes from cork-cli; fail on non-ok state. */
function unwrapChJson(raw: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${label}: stdout is not JSON\n${raw.slice(0, 500)}`);
  }

  const envelope = z
    .object({
      state: z.string().optional(),
      data: z.unknown().optional(),
      warnings: z.array(z.unknown()).optional(),
    })
    .safeParse(parsed);

  if (envelope.success && envelope.data.state !== undefined) {
    if (envelope.data.state !== 'ok') {
      fail(`${label}: ch state is "${envelope.data.state}"\n${raw.slice(0, 1000)}`);
    }
    if (envelope.data.warnings?.length) {
      console.warn(`  ! ${label} warnings:`, envelope.data.warnings);
    }
    return envelope.data.data ?? parsed;
  }

  return parsed;
}

function runCh(args: string[], label: string): unknown {
  const bin = process.env.CH_BIN ?? 'ch';
  console.log(`\n> ${bin} ${args.join(' ')}`);
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      fail(
        `\`ch\` not found (tried "${bin}"). Install cork-cli so \`ch\` is on PATH, or set CH_BIN to the binary.`,
      );
    }
    fail(`${label}: ${err.message}`);
  }

  if (result.status !== 0) {
    fail(
      `${label}: exit ${result.status}\n${(result.stderr || result.stdout || '').slice(0, 2000)}`,
    );
  }

  const stdout = (result.stdout ?? '').trim();
  if (!stdout) fail(`${label}: empty stdout`);
  return unwrapChJson(stdout, label);
}

const marketPredictSchema = z.object({
  poolId: z.string().min(1),
  corkSwapToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/u).optional(),
  // Some CLI versions may use swapToken / corkSwapToken interchangeably.
  swapToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/u).optional(),
});

const orderItemSchema = z.object({
  orderHash: z.string().regex(/^0x[a-fA-F0-9]+$/u),
  side: z.string().optional(),
  status: z.string().optional(),
  remainingMakingAmount: z.union([z.string(), z.number()]).optional(),
  makingAmount: z.union([z.string(), z.number()]).optional(),
  remainingTakingAmount: z.union([z.string(), z.number()]).optional(),
  takingAmount: z.union([z.string(), z.number()]).optional(),
  makerAsset: z.string().optional(),
  takerAsset: z.string().optional(),
});

function asBigInt(value: string | number | undefined, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  return BigInt(value);
}

function pickSellOrder(payload: unknown, amount: bigint): z.infer<typeof orderItemSchema> {
  const list = z
    .object({ items: z.array(z.unknown()).optional() })
    .or(z.array(z.unknown()))
    .safeParse(payload);

  const items: unknown[] = list.success
    ? Array.isArray(list.data)
      ? list.data
      : (list.data.items ?? [])
    : [];

  if (items.length === 0) {
    fail('orderbook returned no items — no resting asks for this poolId');
  }

  const open = new Set(['OPEN', 'PARTIALLY_FILLED', 'open', 'partially_filled']);

  for (const raw of items) {
    const item = orderItemSchema.safeParse(raw);
    if (!item.success) continue;
    const side = (item.data.side ?? 'SELL').toUpperCase();
    if (side !== 'SELL') continue;
    if (item.data.status && !open.has(item.data.status)) continue;

    const remaining = asBigInt(
      item.data.remainingMakingAmount,
      asBigInt(item.data.makingAmount, 0n),
    );
    if (remaining < amount) continue;
    return item.data;
  }

  fail(
    `no OPEN/PARTIALLY_FILLED SELL ask with remainingMakingAmount >= ${amount.toString()} — ` +
      'post a bid / wait for underwriter liquidity, or lower --amount',
  );
}

function runCoverSend(artifactPath: string, dryRun: boolean): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const coverScript = join(here, 'cover.ts');
  const tsxBin = join(here, '../../node_modules/.bin/tsx');
  const args = [coverScript, 'send', artifactPath, ...(dryRun ? ['--dry-run'] : [])];

  console.log(`\n> tsx ${args.join(' ')}`);
  const result = spawnSync(tsxBin, args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      fail(`tsx not found at ${tsxBin} — run from zyfai/ with dependencies installed`);
    }
    fail(`cover send: ${err.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main(): Promise<void> {
  const { amount, expiry, recipe, dryRun } = parseArgs(process.argv.slice(2));
  const amountBn = BigInt(amount);

  if (!env.COVER_REF) fail('COVER_REF is required');
  if (!env.COVER_CA) fail('COVER_CA is required');

  const rpcUrl = env.CORK_RPC_URL ?? env.BASE_RPC_URL ?? env.ALCHEMY_RPC_URL;
  if (!rpcUrl) fail('CORK_RPC_URL (or BASE_RPC_URL / ALCHEMY_RPC_URL) is required');

  const ctx = await createSessionContext({ chainId: env.CORK_CHAIN_ID, rpcUrl });
  console.log(`chain   : ${ctx.chain.name} (${ctx.chain.id})`);
  console.log(`safe    : ${ctx.safeAddress}`);
  console.log(`amount  : ${amount} cST base units`);
  console.log(`expiry  : ${expiry}`);
  console.log(`recipe  : ${recipe}`);
  if (dryRun) console.log('mode    : --dry-run (prepare only path through cover pre-flight)');

  // 1) market-predict
  const predictPayload = {
    resource: 'market-predict',
    chainId: env.CORK_CHAIN_ID,
    filters: {
      collateralAsset: env.COVER_CA,
      referenceAsset: env.COVER_REF,
      expiry,
      recipe,
    },
  };
  const predictRaw = runCh(['query', '--json', JSON.stringify(predictPayload)], 'market-predict');
  const predict = marketPredictSchema.safeParse(predictRaw);
  if (!predict.success) {
    fail(`market-predict: unexpected shape\n${JSON.stringify(predictRaw, null, 2).slice(0, 1000)}`);
  }

  const cst = predict.data.corkSwapToken ?? predict.data.swapToken;
  console.log(`poolId  : ${predict.data.poolId}`);
  if (cst) console.log(`cST     : ${cst}`);

  if (env.COVER_CST && cst && !sameAddress(env.COVER_CST, cst)) {
    fail(
      `market-predict cST ${cst} != COVER_CST ${env.COVER_CST} — update COVER_CST or check REF/CA/expiry/recipe`,
    );
  }

  // 2) orderbook
  const bookPayload = {
    resource: 'orderbook',
    chainId: env.CORK_CHAIN_ID,
    filters: {
      poolId: predict.data.poolId,
      side: 'SELL',
    },
  };
  const bookRaw = runCh(['query', '--json', JSON.stringify(bookPayload)], 'orderbook');
  const order = pickSellOrder(bookRaw, amountBn);

  const remaining = asBigInt(order.remainingMakingAmount, asBigInt(order.makingAmount, 0n));
  const takingCap = asBigInt(order.remainingTakingAmount, asBigInt(order.takingAmount, 0n));
  // Pro-rata premium estimate if the ask quotes full size.
  const makingFull = asBigInt(order.makingAmount, remaining);
  const takingFull = asBigInt(order.takingAmount, takingCap);
  const premiumApprox =
    makingFull > 0n ? (takingFull * amountBn + makingFull - 1n) / makingFull : 0n;

  console.log(`order   : ${order.orderHash}`);
  console.log(`remain  : ${remaining.toString()} cST`);
  console.log(`you pay : ~${premiumApprox.toString()} base units of CA (approx from ask ratio)`);

  // 3) prepare taker-fill
  const preparePayload = {
    chainId: env.CORK_CHAIN_ID,
    account: ctx.safeAddress,
    clientRequestId: `buy-${Date.now()}`,
    action: {
      type: 'taker-fill',
      orderHash: order.orderHash,
      fillMakingAmount: amount,
    },
  };
  const prepareRaw = runCh(
    ['prepare', 'orders', '--json', JSON.stringify(preparePayload)],
    'prepare taker-fill',
  );

  // cover.ts accepts envelope or bare data — re-wrap as ok envelope for clarity.
  const artifact = { state: 'ok', data: prepareRaw };
  const dir = mkdtempSync(join(tmpdir(), 'zyfai-buy-cover-'));
  const artifactPath = join(dir, 'buy.json');
  try {
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`artifact: ${artifactPath}`);

    // 4) cover send (validates + session-key Rhinestone intent)
    runCoverSend(artifactPath, dryRun);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nDone.');
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`\nFAILED: ${detail}`);
  process.exit(1);
});
