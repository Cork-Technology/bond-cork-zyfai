/**
 * End-to-end demand-side cover loop, driven by the SESSION KEY via Rhinestone.
 *
 * Prerequisites: `npm run provision:account` once (Safe + GUARD_MODULE + intent session).
 *
 * Split of responsibilities — Cork's tooling builds unsigned bytes and never signs; this script is
 * the other half: it validates those bytes, pre-flights them against live state, and pushes them
 * through the session key as a single sponsored Rhinestone intent (`executeGuardedBatch`).
 *
 *   ch prepare ... --json '{...}'   ->   artifact.json   ->   cover.ts send artifact.json
 *
 * The loop (REF = the asset the user is exposed to, e.g. an ERC-4626 vault share; CA = what the
 * Safe receives on exercise; cST = the cover token):
 *
 *   1. Derive the market (off-chain, before it exists):
 *      ch query --json '{"resource":"market-predict","chainId":42161,"filters":{
 *        "collateralAsset":"<CA>","referenceAsset":"<REF>","expiry":"<unix>","recipe":"<recipe>"}}'
 *      -> poolId, corkSwapToken (the cST to put in COVER_CST), oracle, resolved constraint.
 *
 *   2. Find the underwriter's signed SELL ask (makerAsset = cST, takerAsset = CA):
 *      ch query --json '{"resource":"orderbook","chainId":42161,"filters":{"poolId":"<poolId>"}}'
 *
 *   3. Build the unsigned fill, then send it here:
 *      ch prepare orders --json '{"chainId":42161,"account":"<SAFE>","clientRequestId":"buy-0001",
 *        "action":{"type":"taker-fill","orderHash":"<hash>","fillMakingAmount":"<cST wanted>"}}' \
 *        > buy.json
 *      tsx src/scripts/cover.ts send buy.json
 *      The fill is atomic: the JIT adapter creates the market if new, mints the cST, and the LOP
 *      pulls the CA premium from the Safe.
 *
 *   4. On impairment, exercise (cST + REF -> CA):
 *      ch prepare phoenix --json '{"chainId":42161,"account":"<SAFE>","clientRequestId":"ex-0001",
 *        "fundingMode":"erc20-approve","action":{"type":"exercise", ...}}' > exercise.json
 *      tsx src/scripts/cover.ts send exercise.json --approve <cST>:<corkAdapter>:<amount> \
 *                                                   --approve <REF>:<corkAdapter>:<amount>
 *
 * Approval spenders differ per leg and the same `approve` selector is used for all of them:
 *   CA  -> 1inch LOP        (the fill pulls the premium)
 *   cST -> Cork adapter     (only on the Bundler3 route; the direct PoolManager path needs none)
 *   REF -> Cork adapter     (Bundler3 route) or CorkPoolManager (direct path)
 *
 * Usage:
 *   tsx src/scripts/cover.ts status
 *   tsx src/scripts/cover.ts approve <token>:<spender>:<amount> [...] [--dry-run]
 *   tsx src/scripts/cover.ts send <artifact.json|-> [--approve tok:spender:amt] [--dry-run]
 *                                 [--no-auto-approve] [--allow-unverified-legs]
 *
 * Token aliases: CA / REF / cST (from COVER_*). Spender aliases: LOP / adapter / poolManager /
 * bundler3 (from CORK_*). Amounts are base units, or `max`.
 */
import { readFile } from 'node:fs/promises';
import type { Address, Hex } from 'viem';
import { decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, maxUint256, parseAbi } from 'viem';
import { z } from 'zod';

import { env } from '../config/env.js';
import {
  createSessionContext,
  GUARDED_BATCH_SIM_ABI,
  type Execution,
  type SessionContext,
} from '../services/session.js';

/**
 * 1inch v6 TakerTraits layout, verbatim from cork-cli `packages/core/src/orders.ts` and confirmed
 * by decomposing a live `taker-fill` artifact: bit 251 set means `args` is prefixed with a 20-byte
 * receiver for the maker asset, and the low 185 bits carry the taking-amount cap.
 */
const TAKER_ARGS_HAS_RECEIVER_FLAG = 1n << 251n;
const TAKER_MAKER_AMOUNT_FLAG = 1n << 255n;
const TAKER_THRESHOLD_MAX = (1n << 185n) - 1n;

const LOP_FILL_ABI = parseAbi([
  'function fillOrderArgs((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order, bytes32 r, bytes32 vs, uint256 amount, uint256 takerTraits, bytes args) returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)',
  'function fillContractOrderArgs((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order, bytes signature, uint256 amount, uint256 takerTraits, bytes args) returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)',
]);

/** The 20-byte receiver `args` is prefixed with when bit 251 is set, or undefined when it is not. */
function decodeFillReceiver(calldata: Hex): string | undefined {
  try {
    const decoded = decodeFunctionData({ abi: LOP_FILL_ABI, data: calldata });
    const args = decoded.functionName === 'fillOrderArgs' ? decoded.args[5] : decoded.args[4];
    return args.length < 2 + 40 ? undefined : `0x${args.slice(2, 42)}`;
  } catch {
    return undefined;
  }
}

const BUNDLER3_MULTICALL_ABI = [
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'bundle',
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'data', type: 'bytes' },
          { name: 'value', type: 'uint256' },
          { name: 'skipRevert', type: 'bool' },
          { name: 'callbackHash', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/**
 * CorkAdapter's 13 `onlyBundler3` actions. Param structs verbatim from `ICorkAdapter.sol` (via
 * cork-cli `packages/core/src/bundle/corkAdapterAbi.ts`). `receiver` — and `owner` on the five
 * actions that take one — is the argument a `(contract, selector)` whitelist cannot see, and its
 * position is NOT uniform across the set, so these are decoded by ABI, never by byte offset.
 */
const CORK_ADAPTER_ABI = parseAbi([
  'function safeMint((bytes32 poolId, uint256 cptAndCstSharesOut, address receiver, uint256 maxCollateralAssetsIn, uint256 deadline) params)',
  'function safeDeposit((bytes32 poolId, uint256 collateralAssetsIn, address receiver, uint256 minCptAndCstSharesOut, uint256 deadline) params)',
  'function safeUnwindDeposit((bytes32 poolId, uint256 collateralAssetsOut, address owner, address receiver, uint256 maxCptAndCstSharesIn, uint256 deadline) params)',
  'function safeUnwindMint((bytes32 poolId, uint256 cptAndCstSharesIn, address owner, address receiver, uint256 minCollateralAssetsOut, uint256 deadline) params)',
  'function safeWithdraw((bytes32 poolId, uint256 collateralAssetsOut, address owner, address receiver, uint256 maxCptSharesIn, uint256 deadline) params)',
  'function safeWithdrawOther((bytes32 poolId, uint256 referenceAssetsOut, address owner, address receiver, uint256 maxCptSharesIn, uint256 deadline) params)',
  'function safeRedeem((bytes32 poolId, uint256 cptSharesIn, address owner, address receiver, uint256 minReferenceAssetsOut, uint256 minCollateralAssetsOut, uint256 deadline) params)',
  'function safeUnwindSwap((bytes32 poolId, uint256 collateralAssetsIn, address receiver, uint256 minReferenceAssetsOut, uint256 minCstSharesOut, uint256 deadline) params)',
  'function safeSwap((bytes32 poolId, uint256 collateralAssetsOut, address receiver, uint256 maxCstSharesIn, uint256 maxReferenceAssetsIn, uint256 deadline) params)',
  'function safeExercise((bytes32 poolId, uint256 cstSharesIn, address receiver, uint256 minCollateralAssetsOut, uint256 maxReferenceAssetsIn, uint256 deadline) params)',
  'function safeExerciseOther((bytes32 poolId, uint256 referenceAssetsIn, address receiver, uint256 minCollateralAssetsOut, uint256 maxCstSharesIn, uint256 deadline) params)',
  'function safeUnwindExercise((bytes32 poolId, uint256 cstSharesOut, address receiver, uint256 minReferenceAssetsOut, uint256 maxCollateralAssetsIn, uint256 deadline) params)',
  'function safeUnwindExerciseOther((bytes32 poolId, uint256 referenceAssetsOut, address receiver, uint256 minCstSharesOut, uint256 maxCollateralAssetsIn, uint256 deadline) params)',
]);

/**
 * Bundler3 CoreAdapter token helpers. Funding legs pull INTO the adapter; sweep-back legs push the
 * unspent remainder OUT — and `erc20Transfer` is `onlyBundler3` without ever checking that its
 * receiver is the initiator, so a residue sent anywhere else is claimable by anyone.
 */
const ADAPTER_TRANSFER_ABI = parseAbi([
  'function erc20TransferFrom(address token, address receiver, uint256 amount)',
  'function permit2TransferFrom(address token, address receiver, uint256 amount)',
  'function erc20Transfer(address token, address receiver, uint256 amount)',
  'function nativeTransfer(address receiver, uint256 amount)',
]);

const decodeTransferLeg = (data: Hex) => {
  try {
    return decodeFunctionData({ abi: ADAPTER_TRANSFER_ABI, data });
  } catch {
    return undefined;
  }
};

const decodeActionLeg = (data: Hex) => {
  try {
    return decodeFunctionData({ abi: CORK_ADAPTER_ABI, data });
  } catch {
    return undefined;
  }
};

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/u, 'invalid 20-byte address');
const hexSchema = z.string().regex(/^0x[a-fA-F0-9]*$/u, 'invalid hex string');
const uintSchema = z.string().regex(/^[0-9]+$/u, 'expected a decimal base-unit string');

const bundlerArtifactSchema = z.object({
  bundler3: addressSchema,
  corkAdapter: addressSchema.optional(),
  action: z.string().optional(),
  fundingMode: z.string().optional(),
  multicall: hexSchema,
});

const callArtifactSchema = z.object({
  to: addressSchema,
  calldata: hexSchema,
  value: uintSchema.optional(),
  from: addressSchema.optional(),
  kind: z.string().optional(),
  orderHash: hexSchema.optional(),
  makerAsset: addressSchema.optional(),
  takerAsset: addressSchema.optional(),
  fillFunction: z.string().optional(),
  requiredMakingAmount: uintSchema.optional(),
  requiredTakingAmount: uintSchema.optional(),
  takerTraits: uintSchema.optional(),
});

type CallArtifact = z.infer<typeof callArtifactSchema>;

type NormalizedArtifact = {
  label: string;
  execution: Execution;
  fill?: CallArtifact;
  bundlerMulticall?: Hex;
};

type ApprovalSpec = {
  token: Address;
  spender: Address;
  amount: bigint;
};

function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

async function readArtifactSource(path: string): Promise<string> {
  if (path !== '-') return readFile(path, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Accepts either a full `ch`/MCP envelope (`{state, data, warnings, provenance}`) or a bare `data`
 * object, and narrows it to the single call the session key has to execute.
 */
function normalizeArtifact(raw: string): NormalizedArtifact {
  const parsed: unknown = JSON.parse(raw);
  const envelope = z
    .object({ state: z.string().optional(), data: z.unknown().optional(), warnings: z.array(z.unknown()).optional() })
    .safeParse(parsed);

  if (envelope.success && envelope.data.state && envelope.data.state !== 'ok') {
    fail(`artifact envelope state is "${envelope.data.state}" — do not send a non-ok artifact`);
  }
  const payload: unknown =
    envelope.success && envelope.data.data !== undefined ? envelope.data.data : parsed;

  const bundler = bundlerArtifactSchema.safeParse(payload);
  if (bundler.success) {
    if (env.CORK_BUNDLER3 && !sameAddress(bundler.data.bundler3, env.CORK_BUNDLER3)) {
      fail(
        `artifact would call ${bundler.data.bundler3}, not the configured Bundler3 ` +
          `(${env.CORK_BUNDLER3})`,
      );
    }
    return {
      label: `phoenix:${bundler.data.action ?? 'bundle'} via Bundler3`,
      execution: {
        target: bundler.data.bundler3 as Address,
        value: 0n,
        callData: bundler.data.multicall as Hex,
      },
      bundlerMulticall: bundler.data.multicall as Hex,
    };
  }

  const call = callArtifactSchema.safeParse(payload);
  if (call.success) {
    const known = [
      env.CORK_LOP,
      env.CORK_BUNDLER3,
      env.CORK_ADAPTER,
      env.CORK_POOL_MANAGER,
      env.COVER_REF,
      env.COVER_CA,
      env.COVER_CST,
    ];
    if (!known.some((address) => sameAddress(address, call.data.to))) {
      console.warn(
        `  ! artifact targets ${call.data.to}, which is none of the configured Cork or token ` +
          'addresses — check it before sending.',
      );
    }
    return {
      label: call.data.fillFunction
        ? `lop:${call.data.fillFunction}`
        : `call:${call.data.kind ?? 'raw'}`,
      execution: {
        target: call.data.to as Address,
        value: BigInt(call.data.value ?? '0'),
        callData: call.data.calldata as Hex,
      },
      fill: call.data.fillFunction ? call.data : undefined,
    };
  }

  fail(
    'unrecognized artifact: expected a Cork `{to, calldata}` object or a `{bundler3, multicall}` bundle',
  );
}

/** Role aliases so a runbook never has to paste a raw address twice. */
function resolveTokenAlias(name: string): Address {
  const aliases: Record<string, string | undefined> = {
    ca: env.COVER_CA,
    ref: env.COVER_REF,
    cst: env.COVER_CST,
  };
  const resolved = aliases[name.toLowerCase()] ?? name;
  if (!addressSchema.safeParse(resolved).success) {
    fail(`unknown token "${name}" — pass an address, or set COVER_CA / COVER_REF / COVER_CST`);
  }
  return resolved as Address;
}

function resolveSpenderAlias(name: string): Address {
  const aliases: Record<string, string | undefined> = {
    lop: env.CORK_LOP,
    adapter: env.CORK_ADAPTER,
    corkadapter: env.CORK_ADAPTER,
    poolmanager: env.CORK_POOL_MANAGER,
    bundler3: env.CORK_BUNDLER3,
  };
  const resolved = aliases[name.toLowerCase()] ?? name;
  if (!addressSchema.safeParse(resolved).success) {
    fail(`unknown spender "${name}" — pass an address, or set CORK_LOP / CORK_ADAPTER / CORK_POOL_MANAGER`);
  }
  return resolved as Address;
}

function parseApprovalSpec(value: string): ApprovalSpec {
  const [token, spender, amount] = value.split(':');
  if (!token || !spender || !amount) {
    fail(`approval "${value}" must be token:spender:amount (amount in base units, or "max")`);
  }
  return {
    token: resolveTokenAlias(token),
    spender: resolveSpenderAlias(spender),
    amount: amount === 'max' ? maxUint256 : BigInt(amount),
  };
}

function parseApprovalFlags(argv: string[]): ApprovalSpec[] {
  const specs: ApprovalSpec[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--approve') continue;
    const value = argv[i + 1];
    if (!value) fail('--approve needs a `token:spender:amount` value');
    specs.push(parseApprovalSpec(value));
  }
  return specs;
}

function encodeApprove(spec: ApprovalSpec): Execution {
  return {
    target: spec.token,
    value: 0n,
    callData: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spec.spender, spec.amount],
    }),
  };
}

type TokenInfo = { symbol: string; decimals: number };

/** Display metadata only — a flaky or rate-limited RPC must never block a transaction. */
async function tokenInfo(ctx: SessionContext, token: Address): Promise<TokenInfo | undefined> {
  try {
    const [symbol, decimals] = await Promise.all([
      ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return { symbol, decimals };
  } catch {
    return undefined;
  }
}

function describeAmount(info: TokenInfo | undefined, value: bigint): string {
  if (value === maxUint256) return 'unlimited';
  return info ? formatUnits(value, info.decimals) : `${value} base units`;
}

async function allowanceOf(ctx: SessionContext, token: Address, spender: Address): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ctx.safeAddress, spender],
  });
}

/** Same read, but for display only — a failed read prints `unreadable` instead of aborting. */
async function allowanceForDisplay(
  ctx: SessionContext,
  token: Address,
  spender: Address,
): Promise<bigint | undefined> {
  try {
    return await allowanceOf(ctx, token, spender);
  } catch {
    return undefined;
  }
}

/**
 * Everything a `(contract, selector)` whitelist cannot see: who receives the bought cST, and how
 * much the fill is actually allowed to charge.
 */
function assertFillIsSafe(ctx: SessionContext, fill: CallArtifact): void {
  if (fill.from && !sameAddress(fill.from, ctx.safeAddress)) {
    fail(
      `artifact was built for account ${fill.from}, but this session drives ${ctx.safeAddress}. ` +
        'Rebuild it with "account": "<safe>".',
    );
  }
  if (!sameAddress(fill.to, env.CORK_LOP)) {
    fail(`fill target ${fill.to} is not the configured 1inch LOP (${env.CORK_LOP})`);
  }
  if (fill.takerTraits) {
    const traits = BigInt(fill.takerTraits);
    if ((traits & TAKER_ARGS_HAS_RECEIVER_FLAG) !== 0n) {
      const receiver = decodeFillReceiver(fill.calldata as Hex);
      if (!receiver) {
        fail('takerTraits bit 251 is set but `args` carries no 20-byte receiver — malformed fill');
      }
      if (!sameAddress(receiver, ctx.safeAddress)) {
        fail(
          `takerTraits bit 251 routes the bought asset to ${receiver}, not the Safe ` +
            `${ctx.safeAddress}. Rebuild the fill without a receiver override.`,
        );
      }
      console.log(`  fill receiver override -> the Safe (ok)`);
    }
    if (fill.requiredTakingAmount) {
      if ((traits & TAKER_MAKER_AMOUNT_FLAG) === 0n) {
        console.warn(
          '  ! takerTraits bit 255 is unset: the threshold field is a minimum-making bound, not a ' +
            'payment cap — verify the amounts manually.',
        );
      } else {
        const cap = traits & TAKER_THRESHOLD_MAX;
        if (cap > BigInt(fill.requiredTakingAmount)) {
          fail(
            `the fill's taking-amount cap is ${cap} but the artifact advertises ` +
              `${fill.requiredTakingAmount} — it could charge the Safe more than quoted`,
          );
        }
      }
    }
  }
  if (env.COVER_CST && fill.makerAsset && !sameAddress(fill.makerAsset, env.COVER_CST)) {
    fail(
      `fill would buy ${fill.makerAsset}, but COVER_CST is ${env.COVER_CST}. ` +
        'A different cST means a different poolId — re-derive with market-predict.',
    );
  }
  if (env.COVER_CA && fill.takerAsset && !sameAddress(fill.takerAsset, env.COVER_CA)) {
    fail(`fill would pay in ${fill.takerAsset}, but COVER_CA is ${env.COVER_CA}`);
  }
}

function assertPayout(
  position: string,
  label: string,
  actual: string,
  expected: Address,
  expectedLabel: string,
): void {
  if (!sameAddress(actual, expected)) {
    fail(`${position} ${label}: pays out to ${actual}, not ${expectedLabel} (${expected})`);
  }
  console.log(`  ${position} ${label} -> ${expectedLabel} (ok)`);
}

/**
 * Re-decodes the Bundler3 multicall that is actually being sent — never the artifact's own `bundle`
 * summary — and checks every leg's payout address against the ABI, not a byte offset.
 */
function assertBundleReceivers(ctx: SessionContext, multicallData: Hex, allowUnverified: boolean): void {
  let legs: readonly { to: Address; data: Hex }[];
  try {
    legs = decodeFunctionData({ abi: BUNDLER3_MULTICALL_ABI, data: multicallData }).args[0];
  } catch {
    fail('bundle is not a decodable Bundler3 `multicall((address,bytes,uint256,bool,bytes32)[])`');
  }

  legs.forEach((leg, index) => {
    const position = `leg ${index + 1}`;

    // Every leg of a Cork bundle targets the Cork adapter — funding, action, and sweep-back alike.
    if (env.CORK_ADAPTER && !sameAddress(leg.to, env.CORK_ADAPTER)) {
      fail(`${position} targets ${leg.to}, not the configured Cork adapter (${env.CORK_ADAPTER})`);
    }

    const transfer = decodeTransferLeg(leg.data);
    if (transfer) {
      switch (transfer.functionName) {
        case 'erc20TransferFrom':
        case 'permit2TransferFrom':
          return assertPayout(position, transfer.functionName, transfer.args[1], leg.to, 'the adapter');
        case 'erc20Transfer':
          return assertPayout(position, transfer.functionName, transfer.args[1], ctx.safeAddress, 'the Safe');
        case 'nativeTransfer':
          return assertPayout(position, transfer.functionName, transfer.args[0], ctx.safeAddress, 'the Safe');
      }
    }

    const action = decodeActionLeg(leg.data);
    if (action) {
      const params = action.args[0];
      assertPayout(position, `${action.functionName}.receiver`, params.receiver, ctx.safeAddress, 'the Safe');
      if ('owner' in params) {
        assertPayout(position, `${action.functionName}.owner`, params.owner, ctx.safeAddress, 'the Safe');
      }
      return;
    }

    const message = `${position} (${leg.to} ${leg.data.slice(0, 10)}): no Cork adapter or Bundler3 transfer ABI matches`;
    if (!allowUnverified) {
      fail(`${message}. Decode it with \`ch decode\` first, then re-run with --allow-unverified-legs.`);
    }
    console.warn(`  ! ${message} — sending anyway (--allow-unverified-legs)`);
  });
}

async function autoApprovalForFill(
  ctx: SessionContext,
  fill: CallArtifact,
): Promise<ApprovalSpec | undefined> {
  if (!fill.takerAsset || !fill.requiredTakingAmount) return undefined;
  const token = fill.takerAsset as Address;
  const spender = env.CORK_LOP as Address;
  const required = BigInt(fill.requiredTakingAmount);
  const current = await allowanceOf(ctx, token, spender);
  if (current >= required) return undefined;
  if (current > 0n) {
    console.warn(
      `  ! existing allowance ${current} < required ${required}; raising it in place. ` +
        'Tokens that require a reset to 0 (USDT-style) need a separate --approve leg first.',
    );
  }
  return { token, spender, amount: required };
}

async function simulateBatch(ctx: SessionContext, executions: Execution[]): Promise<void> {
  try {
    await ctx.publicClient.simulateContract({
      address: ctx.guardModule,
      abi: GUARDED_BATCH_SIM_ABI,
      functionName: 'executeGuardedBatch',
      args: [executions],
      account: ctx.safeAddress,
    });
    console.log('  pre-flight : ok (batch does not revert at current state)');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`pre-flight reverted — nothing was sent.\n${message}`);
  }
}

async function runStatus(ctx: SessionContext): Promise<void> {
  const [enabled, deployed] = await Promise.all([
    ctx.isEnabled(),
    ctx.publicClient.getCode({ address: ctx.safeAddress }).then((code) => Boolean(code && code !== '0x')),
  ]);

  console.log(`chain        : ${ctx.chain.name} (${ctx.chain.id})`);
  console.log(`safe         : ${ctx.safeAddress}  ${deployed ? '(deployed)' : '(NOT deployed)'}`);
  console.log(`owner        : ${ctx.ownerAddress}`);
  console.log(`session key  : ${ctx.sessionKeyAddress}`);
  console.log(`guard module : ${ctx.guardModule}`);
  console.log(`permissionId : ${ctx.permissionId}`);
  console.log(`session      : ${enabled ? 'ENABLED' : 'NOT ENABLED — run `npm run provision:account` first'}`);

  const spenders: Array<[string, Address | undefined]> = [
    ['LOP', env.CORK_LOP as Address],
    ['corkAdapter', env.CORK_ADAPTER as Address | undefined],
    ['poolManager', env.CORK_POOL_MANAGER as Address | undefined],
  ];
  const tokens: Array<[string, Address | undefined]> = [
    ['REF', env.COVER_REF as Address | undefined],
    ['CA', env.COVER_CA as Address | undefined],
    ['cST', env.COVER_CST as Address | undefined],
  ];

  for (const [role, token] of tokens) {
    if (!token) continue;
    const info = await tokenInfo(ctx, token);
    const balance = await ctx.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ctx.safeAddress],
    });
    console.log(`\n${role} ${info?.symbol ?? 'token'} (${token})`);
    console.log(`  balance    : ${describeAmount(info, balance)}`);
    for (const [name, spender] of spenders) {
      if (!spender) continue;
      const allowance = await allowanceForDisplay(ctx, token, spender);
      const shown = allowance === undefined ? 'unreadable' : describeAmount(info, allowance);
      console.log(`  -> ${name.padEnd(11)}: ${shown}`);
    }
  }
}

async function runApprove(ctx: SessionContext, argv: string[]): Promise<void> {
  const specs = argv.filter((arg) => !arg.startsWith('--')).map(parseApprovalSpec);
  if (specs.length === 0) {
    fail('usage: cover.ts approve <token>:<spender>:<amount> [...] — aliases: CA REF cST / LOP adapter poolManager');
  }

  console.log(`chain        : ${ctx.chain.name} (${ctx.chain.id})`);
  console.log(`safe         : ${ctx.safeAddress}\n`);
  console.log('approvals:');
  for (const [index, spec] of specs.entries()) {
    const info = await tokenInfo(ctx, spec.token);
    const current = await allowanceForDisplay(ctx, spec.token, spec.spender);
    const from = current === undefined ? 'unreadable' : describeAmount(info, current);
    console.log(
      `  ${index + 1}. ${info?.symbol ?? 'token'} (${spec.token}) -> ${spec.spender}\n` +
        `     ${from} -> ${describeAmount(info, spec.amount)}`,
    );
  }

  if (!(await ctx.isEnabled())) {
    fail('the session is not enabled on this Safe/chain — run `npm run provision:account` first');
  }

  const executions = specs.map(encodeApprove);
  console.log('');
  await simulateBatch(ctx, executions);

  if (argv.includes('--dry-run')) {
    console.log('\n--dry-run: nothing sent.');
    return;
  }

  console.log('\nsending sponsored intent (signed by the session key via Rhinestone)...');
  const result = await ctx.sendGuardedBatch(executions);
  if (result.intentId) console.log(`intentId     : ${result.intentId}`);
  console.log(`tx           : ${result.transactionHash}`);
  console.log(`status       : ${result.success ? 'SUCCESS' : 'FAILED'}`);
  if (!result.success) process.exit(1);
}

async function runSend(ctx: SessionContext, argv: string[]): Promise<void> {
  const artifactPath = argv[0];
  if (!artifactPath || artifactPath.startsWith('--')) {
    fail('usage: cover.ts send <artifact.json|-> [--approve tok:spender:amt] [--dry-run]');
  }

  const dryRun = argv.includes('--dry-run');
  const autoApprove = !argv.includes('--no-auto-approve');
  const allowUnverifiedLegs = argv.includes('--allow-unverified-legs');

  const artifact = normalizeArtifact(await readArtifactSource(artifactPath));
  const approvals = parseApprovalFlags(argv);

  if (artifact.fill) {
    assertFillIsSafe(ctx, artifact.fill);
    if (autoApprove) {
      const auto = await autoApprovalForFill(ctx, artifact.fill);
      if (auto) approvals.unshift(auto);
    }
  }

  if (artifact.bundlerMulticall) {
    console.log('receiver checks:');
    assertBundleReceivers(ctx, artifact.bundlerMulticall, allowUnverifiedLegs);
    console.log('');
  }

  const executions: Execution[] = [...approvals.map(encodeApprove), artifact.execution];

  console.log(`chain        : ${ctx.chain.name} (${ctx.chain.id})`);
  console.log(`safe         : ${ctx.safeAddress}`);
  console.log(`artifact     : ${artifact.label}`);
  if (artifact.fill?.orderHash) console.log(`orderHash    : ${artifact.fill.orderHash}`);
  if (artifact.fill?.requiredTakingAmount) {
    console.log(`you pay      : ${artifact.fill.requiredTakingAmount} base units of ${artifact.fill.takerAsset}`);
  }
  if (artifact.fill?.requiredMakingAmount) {
    console.log(`you receive  : ${artifact.fill.requiredMakingAmount} base units of ${artifact.fill.makerAsset}`);
  }
  console.log('\nbatch:');
  executions.forEach((execution, index) => {
    console.log(`  ${index + 1}. -> ${execution.target}  ${execution.callData.slice(0, 10)}  (${execution.callData.length / 2 - 1} bytes)`);
  });

  if (!(await ctx.isEnabled())) {
    fail('the session is not enabled on this Safe/chain — run `npm run provision:account` first');
  }

  console.log('');
  await simulateBatch(ctx, executions);

  if (dryRun) {
    console.log('\n--dry-run: nothing sent.');
    return;
  }

  console.log('\nsending sponsored intent (signed by the session key via Rhinestone)...');
  const result = await ctx.sendGuardedBatch(executions);
  if (result.intentId) console.log(`intentId     : ${result.intentId}`);
  console.log(`tx           : ${result.transactionHash}`);
  if (result.blockNumber !== undefined) console.log(`block        : ${result.blockNumber}`);
  console.log(`status       : ${result.success ? 'SUCCESS' : 'FAILED'}`);
  if (!result.success) process.exit(1);
}

async function main(): Promise<void> {
  const [, , command, ...argv] = process.argv;
  const rpcUrl = env.CORK_RPC_URL ?? env.BASE_RPC_URL ?? env.ALCHEMY_RPC_URL;

  const ctx = await createSessionContext({ chainId: env.CORK_CHAIN_ID, rpcUrl: rpcUrl ?? '' });

  switch (command) {
    case 'status':
      return runStatus(ctx);
    case 'approve':
      return runApprove(ctx, argv);
    case 'send':
      return runSend(ctx, argv);
    default:
      console.error('usage: cover.ts <status|approve|send> [...]');
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  const detail =
    error instanceof Error
      ? 'shortMessage' in error && typeof error.shortMessage === 'string'
        ? error.shortMessage
        : error.message
      : String(error);
  console.error(`\nFAILED: ${detail}`);
  if (/RPC|HTTP|fetch|timeout/i.test(detail)) {
    console.error('  Set CORK_RPC_URL to your own node — public endpoints rate-limit aggressively.');
  }
  process.exit(1);
});
