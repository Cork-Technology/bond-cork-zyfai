/**
 * Runtime session context for the cover agent.
 *
 * Assumes the Safe was provisioned once via `scripts/provision-account.ts`
 * (deploy + Smart Sessions + Intent Executor + GUARD_MODULE + intent session).
 * Runtime txs are signed by `SESSION_KEY_PRIVATE_KEY` through Rhinestone intents
 * and always go through `GUARD_MODULE.executeGuardedBatch`.
 */
import {
  createPublicClient,
  encodeFunctionData,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Session } from '@rhinestone/sdk';

import { env } from '../config/env.js';
import {
  buildIntentSession,
  getSessionOwner,
  GUARD_MODULE_ABI,
} from './intent-session.js';
import {
  buildAccount,
  executeSponsored,
  getRhinestoneSdk,
  resolveChain,
  type RhinestoneAccount,
} from './rhinestone.js';

export { resolveChain };

export type Execution = {
  target: Address;
  value: bigint;
  callData: Hex;
};

/** Same ABI as `GUARD_MODULE_ABI` — used for eth_call pre-flight simulation. */
export const GUARDED_BATCH_SIM_ABI = GUARD_MODULE_ABI;

export type SendGuardedBatchResult = {
  /** Rhinestone intent id (sponsored path), when available. */
  intentId?: string;
  transactionHash: Hex;
  blockNumber?: bigint;
  success: boolean;
};

export type SessionContext = {
  chain: Chain;
  publicClient: PublicClient;
  account: RhinestoneAccount;
  session: Session;
  safeAddress: Address;
  ownerAddress: Address;
  sessionKeyAddress: Address;
  guardModule: Address;
  permissionId: Hex;
  isEnabled: () => Promise<boolean>;
  sendGuardedBatch: (executions: Execution[]) => Promise<SendGuardedBatchResult>;
};

/**
 * Load the counterfactual Safe + the intent session for `SESSION_KEY_PRIVATE_KEY`.
 * Does not deploy or enable anything — that is `provision:account`.
 */
export async function createSessionContext(opts: {
  chainId: number;
  rpcUrl: string;
}): Promise<SessionContext> {
  if (!opts.rpcUrl) throw new Error('rpcUrl is required (set CORK_RPC_URL or BASE_RPC_URL)');
  if (!env.RHINESTONE_API_KEY) throw new Error('RHINESTONE_API_KEY is required');
  if (!env.GUARD_MODULE) throw new Error('GUARD_MODULE is required');
  if (!env.SESSION_KEY_PRIVATE_KEY) throw new Error('SESSION_KEY_PRIVATE_KEY is required');

  const chain = resolveChain(opts.chainId);
  const guardModule = env.GUARD_MODULE as Address;
  const owner = privateKeyToAccount(env.SHARED_EOA_PRIVATE_KEY as Hex);
  const sessionOwner = getSessionOwner();
  const sdk = getRhinestoneSdk(chain, opts.rpcUrl);
  const account = await buildAccount(owner, chain.id, opts.rpcUrl);
  const session = await buildIntentSession(sdk, chain, guardModule);
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const safeAddress = account.getAddress();

  return {
    chain,
    publicClient,
    account,
    session,
    safeAddress,
    ownerAddress: owner.address,
    sessionKeyAddress: sessionOwner.address,
    guardModule,
    permissionId: session.permissionId,
    isEnabled: () => account.isSessionEnabled(session),
    sendGuardedBatch: (executions) => sendGuardedBatch(account, chain, publicClient, session, guardModule, executions),
  };
}

async function sendGuardedBatch(
  account: RhinestoneAccount,
  chain: Chain,
  publicClient: PublicClient,
  session: Session,
  guardModule: Address,
  executions: Execution[],
): Promise<SendGuardedBatchResult> {
  const data = encodeFunctionData({
    abi: GUARD_MODULE_ABI,
    functionName: 'executeGuardedBatch',
    args: [executions],
  });

  const { txHash, intentId } = await executeSponsored(
    account,
    chain,
    [{ to: guardModule, data, value: 0n }],
    { type: 'session', session },
  );

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => undefined);

  return {
    intentId,
    transactionHash: txHash,
    blockNumber: receipt?.blockNumber,
    success: receipt ? receipt.status === 'success' : true,
  };
}
