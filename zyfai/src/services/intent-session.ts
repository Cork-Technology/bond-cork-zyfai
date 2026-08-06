/**
 * Intent-session helpers: build a session signed by `SESSION_KEY_PRIVATE_KEY`
 * that can (1) call `GUARD_MODULE.executeGuardedBatch` and (2) run Rhinestone
 * intents (`createSession` injects `intent-execution` + WETH deposit).
 */
import type { Address, Chain, Hex, LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { RhinestoneAccount, RhinestoneSDK, Session } from '@rhinestone/sdk';
import { enableSession } from '@rhinestone/sdk/actions/smart-sessions';

import { env } from '../config/env.js';

type EnableSessionCall = ReturnType<typeof enableSession>;

export const GUARD_MODULE_ABI = [
  {
    type: 'function',
    name: 'executeGuardedBatch',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'executions',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export function getSessionOwner(): LocalAccount {
  if (!env.SESSION_KEY_PRIVATE_KEY) throw new Error('SESSION_KEY_PRIVATE_KEY is required');
  return privateKeyToAccount(env.SESSION_KEY_PRIVATE_KEY as Hex);
}

/**
 * Session for the agent: single ECDSA signer from env, scoped to the proxy
 * executor. Intent-execution + WETH deposit are injected by the SDK.
 */
export async function buildIntentSession(
  sdk: RhinestoneSDK,
  chain: Chain,
  guardModule: Address,
): Promise<Session> {
  const sessionOwner = getSessionOwner();

  return sdk.createSession({
    chain,
    owners: { type: 'ecdsa', accounts: [sessionOwner], threshold: 1 },
    permissions: [
      {
        abi: GUARD_MODULE_ABI,
        address: guardModule,
        functions: { executeGuardedBatch: {} },
      },
    ],
  });
}

/** `enableSession` LazyCallInput — owner signs the enable digest first. */
export async function buildEnableSessionCall(
  account: RhinestoneAccount,
  session: Session,
): Promise<EnableSessionCall> {
  const sessionDetails = await account.getSessionDetails([session]);
  const enableSignature = await account.signEnableSession(sessionDetails);
  return enableSession(session, enableSignature, sessionDetails.hashesAndChainIds, 0);
}
