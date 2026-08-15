/**
 * Typed wrapper over the `ch` cork-cli binary.
 *
 * Runtime path — `ch` on PATH runs subprocesses per call (~200-500ms each);
 * negligible vs. userOp fill time. The wrapper hides `spawnSync`, JSON
 * unwrapping, and the `{state, data, warnings}` envelope so consumers get
 * typed inputs and typed errors.
 *
 * Migration path — when Cork publishes a real npm SDK, swap `run()` for
 * in-process handler calls; the public API of this file does not change.
 */
import { spawnSync } from 'node:child_process';
import type { Address, Hex } from 'viem';

export class CorkError extends Error {
  constructor(
    message: string,
    public readonly warnings: readonly unknown[] = [],
  ) {
    super(message);
    this.name = 'CorkError';
  }
}

/** Documented "not servable now" state — retry may be legitimate; inspect `code`. */
export class CorkUnavailableError extends CorkError {
  readonly kind = 'unavailable' as const;
  constructor(
    public readonly code: string,
    warnings: readonly unknown[],
  ) {
    super(`cork unavailable: ${code}`, warnings);
    this.name = 'CorkUnavailableError';
  }
}

/** Chain vs. venue disagreement — do NOT retry; surface to the caller. */
export class CorkConflictError extends CorkError {
  readonly kind = 'conflict' as const;
  constructor(
    public readonly detail: unknown,
    warnings: readonly unknown[],
  ) {
    super('cork conflict — chain/venue mismatch', warnings);
    this.name = 'CorkConflictError';
  }
}

export class CorkBadStateError extends CorkError {
  readonly kind = 'bad-state' as const;
  constructor(
    public readonly state: string,
    warnings: readonly unknown[],
  ) {
    super(`cork unexpected envelope state: ${state}`, warnings);
    this.name = 'CorkBadStateError';
  }
}

type Envelope = {
  state?: string;
  data?: unknown;
  warnings?: unknown[];
};

function unwrap(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorkError(`ch: stdout not JSON — ${raw.slice(0, 400)}`);
  }

  const envelope = parsed as Envelope;
  if (envelope.state === undefined) return parsed;

  const warnings = envelope.warnings ?? [];
  switch (envelope.state) {
    case 'ok':
      // ok-state warnings carry venue notices (deprecations with removal dates,
      // decaying-price notices) — surface them, never swallow them.
      for (const w of warnings) {
        const { code, message } = w as { code?: string; message?: string };
        console.warn(`  ! ch warning [${code ?? '?'}] ${message ?? JSON.stringify(w)}`);
      }
      return envelope.data ?? parsed;
    case 'unavailable': {
      const first = warnings[0] as { code?: string } | undefined;
      throw new CorkUnavailableError(first?.code ?? 'unknown', warnings);
    }
    case 'conflict':
      throw new CorkConflictError(envelope.data ?? warnings, warnings);
    default:
      throw new CorkBadStateError(envelope.state, warnings);
  }
}

function run(args: string[]): unknown {
  const bin = process.env.CH_BIN ?? 'ch';
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new CorkError(
        `\`ch\` not found (tried "${bin}"). Install cork-cli and put ch on PATH, or set CH_BIN.`,
      );
    }
    throw new CorkError(`ch spawn failed: ${err.message}`);
  }

  const stdout = (result.stdout ?? '').trim();
  if (result.status !== 0) {
    if (stdout) return unwrap(stdout);
    throw new CorkError(
      `ch exit ${result.status}: ${(result.stderr ?? '').slice(0, 2000)}`,
    );
  }
  if (!stdout) throw new CorkError('ch: empty stdout');
  return unwrap(stdout);
}

export type ProtocolDeployment = {
  poolManager: Address;
  constraintAdapter: Address;
  corkAdapter: Address;
  bundler3: Address;
  whitelistManager: Address;
};

export type ProtocolConfig = {
  resource?: string;
  chainId?: number;
  deployment: ProtocolDeployment;
  create2Deployer?: Address;
  [k: string]: unknown;
};

export type AssetSource = {
  sourceType: string;
  sourceInterface: string;
  denomination: string;
  address?: Address;
};

export type Asset = {
  address: Address;
  name?: string;
  kind: string;
  priceSource: AssetSource | null;
  navSource: AssetSource | null;
  token: { decimals: number; symbol: string; name?: string };
};

export type Recipe = {
  address: Address;
  source: 'fixed' | 'price' | 'nav';
  description?: string;
};

export type RateConstraint = {
  rateMin: string;
  rateMax: string;
  rateChangePerDayMax: string;
  rateChangeCapacityMax: string;
};

export type DerivedPool = {
  recipe: Address;
  source: string;
  oracle: {
    address: Address;
    deployed: boolean;
    deployable?: boolean;
    mode: string;
    rate?: string;
  };
  pool: {
    poolId: Hex;
    exists: boolean;
    constraint: RateConstraint;
  };
  shares: {
    corkSwapToken: Address;
    corkPrincipalToken: Address;
    source: string;
  };
};

export type Order = {
  orderHash: Hex;
  side: string;
  status: string;
  makerAsset: Address;
  takerAsset: Address;
  remainingMakingAmount?: string;
  makingAmount?: string;
  remainingTakingAmount?: string;
  takingAmount?: string;
  [k: string]: unknown;
};

export type DecodedOrder = {
  jit: {
    generation: string;
    adapter: Address;
    collateralAsset: Address;
    referenceAsset: Address;
    recipe: Address;
    constraint: RateConstraint;
    enableJitMint: boolean;
    permits: number;
  };
};

/**
 * An allowance the CALLER must grant before broadcasting. The spender is
 * structurally `forSelf.adapter` — the artifact never names another spender.
 * `amountField` names the prepare input whose value is the amount;
 * `kind: "cap"` means the adapter sweeps back whatever it does not spend.
 */
export type Allowance = {
  tokenRole: string;
  amountField: string;
  kind: 'exact' | 'cap';
  token: Address;
};

/**
 * A prepared forSelf artifact is ONE unsigned transaction (`to`/`calldata`/
 * `value`), not a bundle: the approvals it needs are described in
 * `forSelf.allowances` for the caller to build, not included as legs.
 */
export type ForSelfArtifact = {
  kind: string;
  to: Address;
  calldata: Hex;
  value: string;
  from: Address;
  /** Unix seconds; the adapter's own deadline check — rebuild if it lapses. */
  deadline?: string;
  forSelf: {
    adapter: Address;
    functionName: string;
    selector: Hex;
    allowances: Allowance[];
    receiverPolicy?: string;
  };
  /**
   * Present when the underlying order is a Cork-native decaying-premium auction.
   * Re-simulate close to broadcast: the taker price falls toward `floor`.
   */
  auction?: { current: string; ceiling: string; floor: string };
  summary?: string[];
  simulationRequired?: boolean;
  execution?: unknown;
  [k: string]: unknown;
};

export type SimulateResult = {
  wouldRevert: boolean;
  revertReason?: string;
  [k: string]: unknown;
};

const CHAIN = (id: number): string[] => ['--chain-id', String(id)];

export async function queryProtocolConfig(chainId: number): Promise<ProtocolConfig> {
  return run(['query', 'protocol-config', ...CHAIN(chainId), '--json']) as ProtocolConfig;
}

export async function queryRegistryAssets(chainId: number): Promise<Asset[]> {
  const raw = run(['query', 'registry-assets', ...CHAIN(chainId), '--json']) as
    | { items?: Asset[] }
    | Asset[];
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}

export async function queryRegistryRecipes(chainId: number): Promise<Recipe[]> {
  const raw = run(['query', 'registry-recipes', ...CHAIN(chainId), '--json']) as
    | { items?: Recipe[] }
    | Recipe[];
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}

export async function queryDeriveCorkPool(input: {
  chainId: number;
  collateralAsset: Address;
  referenceAsset: Address;
  expiry: string | number | bigint;
  recipe: Address;
}): Promise<DerivedPool> {
  return run([
    'query',
    'derive-cork-pool',
    ...CHAIN(input.chainId),
    '--json',
    '--collateral-asset',
    input.collateralAsset,
    '--reference-asset',
    input.referenceAsset,
    '--expiry',
    String(input.expiry),
    '--recipe',
    input.recipe,
  ]) as DerivedPool;
}

export async function queryOrderbook(chainId: number, poolId: Hex): Promise<Order[]> {
  const raw = run([
    'query',
    'orderbook',
    ...CHAIN(chainId),
    '--pool-id',
    poolId,
    '--json',
  ]) as { items?: Order[] } | Order[];
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}

export async function decodeOrder(chainId: number, orderRow: unknown): Promise<DecodedOrder> {
  return run([
    'decode',
    'order',
    ...CHAIN(chainId),
    '--data',
    JSON.stringify(orderRow),
    '--json',
  ]) as DecodedOrder;
}

/**
 * Build an unsigned `fillOrderForSelf` artifact routed through your deployed
 * CorkForSelfAdapter. Allowances land on the adapter (never the LOP). The
 * bought cST is structurally forced to `account`.
 *
 * `clientRequestId` — reuse the SAME id to retry a request (venue dedupes and
 * you get the same artifact back). A NEW request needs a FRESH id. Two live
 * orders sharing an id can kill each other via the 1inch bit invalidator.
 */
export async function prepareFillForSelf(input: {
  chainId: number;
  account: Address;
  orderHash: Hex;
  fillMakingAmount: string;
  adapter: Address;
  poolId: Hex;
  clientRequestId: string;
}): Promise<ForSelfArtifact> {
  return run([
    'fill',
    ...CHAIN(input.chainId),
    '--json',
    '--account',
    input.account,
    '--client-request-id',
    input.clientRequestId,
    '--order-hash',
    input.orderHash,
    '--fill-making-amount',
    input.fillMakingAmount,
    '--for-self',
    JSON.stringify({ adapter: input.adapter, poolId: input.poolId }),
  ]) as ForSelfArtifact;
}

/**
 * Build an unsigned `exerciseForSelf` artifact. The adapter has no receiver
 * parameter on-chain, but the prepare schema still requires `action.receiver`
 * and asserts it equals `account` on the forSelf path — so we pass it.
 *
 * Pass `rpcUrl` so funding legs resolve (otherwise `fundingLegs: 0` +
 * `funding_needs_rpc` warning).
 */
export async function prepareExerciseForSelf(input: {
  chainId: number;
  account: Address;
  poolId: Hex;
  cstSharesIn: string;
  minCollateralAssetsOut: string;
  maxReferenceAssetsIn: string;
  adapter: Address;
  clientRequestId: string;
  rpcUrl?: string;
}): Promise<ForSelfArtifact> {
  const rpcArgs = input.rpcUrl ? ['--rpc-url', input.rpcUrl] : [];
  return run([
    'exercise',
    ...CHAIN(input.chainId),
    '--json',
    ...rpcArgs,
    '--account',
    input.account,
    '--client-request-id',
    input.clientRequestId,
    '--pool-id',
    input.poolId,
    '--receiver',
    input.account,
    '--cst-shares-in',
    input.cstSharesIn,
    '--min-collateral-assets-out',
    input.minCollateralAssetsOut,
    '--max-reference-assets-in',
    input.maxReferenceAssetsIn,
    '--for-self',
    JSON.stringify({ adapter: input.adapter }),
  ]) as ForSelfArtifact;
}

/**
 * Pre-flight `eth_call` simulation of a prepared artifact. Callers should
 * REQUIRE `wouldRevert: false` before signing.
 */
export async function trackSimulate(
  chainId: number,
  artifact: unknown,
): Promise<SimulateResult> {
  return run([
    'track',
    'simulate',
    ...CHAIN(chainId),
    '--json',
    '--subject',
    JSON.stringify({ kind: 'artifact', artifact }),
  ]) as SimulateResult;
}

/**
 * Post-broadcast reconciliation between the indexer (venue) and the chain.
 * Chain outranks the indexer on disagreement.
 *
 * `ch track reconcile` takes ONE `--subject` per call (`{"kind":"txHash",…}` or
 * `{"kind":"orderHash",…}`); it has no --order-hash/--tx-hash flags. Two calls:
 * first the receipt (did OUR tx land), then the order lifecycle (does the venue
 * index agree with the chain).
 */
export async function trackReconcile(
  chainId: number,
  orderHash: Hex,
  txHash: Hex,
): Promise<{ tx: unknown; order: unknown }> {
  const tx = run([
    'track',
    'reconcile',
    ...CHAIN(chainId),
    '--json',
    '--subject',
    JSON.stringify({ kind: 'txHash', txHash }),
  ]);
  const order = run([
    'track',
    'reconcile',
    ...CHAIN(chainId),
    '--json',
    '--subject',
    JSON.stringify({ kind: 'orderHash', orderHash }),
  ]);
  return { tx, order };
}
