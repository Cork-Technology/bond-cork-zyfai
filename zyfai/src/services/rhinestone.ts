/**
 * Thin Rhinestone SDK wiring for the session Safe.
 *
 * The SDK owns deploy + Smart Sessions + Intent Executor + sessions fallback.
 * We only add `GUARD_MODULE` (proxy executor) as a custom module, then enable an
 * intent session in the same sponsored userOp (`scripts/provision-account.ts`).
 */
import type { Address, Chain, Hex, LocalAccount } from 'viem';
import {
  RhinestoneSDK,
  type CallInput,
  type RhinestoneAccount,
  type SignerSet,
} from '@rhinestone/sdk';
import { arbitrum, base, mainnet } from 'viem/chains';

import { env } from '../config/env.js';

export type { RhinestoneAccount };

export function resolveChain(chainId: number): Chain {
  switch (chainId) {
    case mainnet.id:
      return mainnet;
    case arbitrum.id:
      return arbitrum;
    case base.id:
      return base;
    default:
      throw new Error(
        `Unsupported chainId ${chainId} — expected one of ${mainnet.id}, ${arbitrum.id}, ${base.id}`,
      );
  }
}

export function getRhinestoneSdk(chain: Chain, rpcUrl: string): RhinestoneSDK {
  if (!env.RHINESTONE_API_KEY) throw new Error('RHINESTONE_API_KEY is required');

  return new RhinestoneSDK({
    auth: { mode: 'apiKey', apiKey: env.RHINESTONE_API_KEY },
    provider: { type: 'custom', urls: { [chain.id]: rpcUrl } },
    bundler: { type: 'pimlico', apiKey: env.PIMLICO_API_KEY },
    paymaster: { type: 'pimlico', apiKey: env.PIMLICO_API_KEY },
  });
}

/**
 * Counterfactual Safe (CREATE2 from owner + `SAFE_SALT_NONCE`).
 * `sessions.enabled` installs Smart Sessions + Intent Executor + compat fallback
 * at deploy; `GUARD_MODULE` is the only extra executor we pass in.
 */
export async function buildAccount(
  owner: LocalAccount,
  chainId: number,
  rpcUrl: string,
): Promise<RhinestoneAccount> {
  if (!env.GUARD_MODULE) throw new Error('GUARD_MODULE is required');

  const chain = resolveChain(chainId);
  const sdk = getRhinestoneSdk(chain, rpcUrl);
  const guardModule = env.GUARD_MODULE as Address;

  return sdk.createAccount({
    account: {
      type: 'safe',
      version: '1.4.1',
      adapter: '1.0.0',
      nonce: env.SAFE_SALT_NONCE,
    },
    owners: { type: 'ecdsa', accounts: [owner], threshold: 1 },
    sessions: { enabled: true },
    modules: [{ type: 'executor', address: guardModule, initData: '0x' }],
  });
}

export type SponsoredResult = {
  txHash: Hex;
  intentId?: string;
};

/** Sponsored same-chain intent: prepare → sign → submit → wait for fill hash. */
export async function executeSponsored(
  account: RhinestoneAccount,
  chain: Chain,
  calls: CallInput[],
  signers?: SignerSet,
): Promise<SponsoredResult> {
  const prepared = await account.prepareTransaction({
    chain,
    calls,
    tokenRequests: [],
    sponsored: true,
    ...(signers ? { signers } : {}),
  });
  const signed = await account.signTransaction(prepared);
  const result = await account.submitTransaction(signed);
  const intentId = result.type === 'intent' ? result.id : undefined;
  console.log('intentId:', intentId ?? result);
  const status = await account.waitForExecution(result);

  // SDK v2 TransactionStatus: { status, operations: [{ chain, status, txHash? }] }
  const ops =
    (status as { status?: string; operations?: { chain: number; status: string; txHash?: Hex }[] })
      .operations ?? [];
  const completed = ops.find((op) => op.status === 'COMPLETED' && op.txHash);
  if (!completed?.txHash) {
    console.error('intent status:', JSON.stringify(status, null, 2));
    throw new Error(
      `Rhinestone intent finished without txHash (status=${(status as { status?: string }).status})`,
    );
  }
  return { txHash: completed.txHash, intentId };
}
