/**
 * One sponsored userOp via Rhinestone SDK:
 *   deploy Safe (CREATE2 from owner + SAFE_SALT_NONCE)
 *   + install Smart Sessions / Intent Executor / sessions fallback (SDK)
 *   + install GUARD_MODULE (proxy executor)
 *   + enable an intent session for SESSION_KEY_PRIVATE_KEY
 */
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { env } from '../config/env.js';
import { buildEnableSessionCall, buildIntentSession, getSessionOwner } from '../services/intent-session.js';
import { buildAccount, executeSponsored, getRhinestoneSdk, resolveChain } from '../services/rhinestone.js';

async function main(): Promise<void> {
  if (!env.RHINESTONE_API_KEY) throw new Error('RHINESTONE_API_KEY is required');
  if (!env.GUARD_MODULE) throw new Error('GUARD_MODULE is required');
  if (!env.SESSION_KEY_PRIVATE_KEY) throw new Error('SESSION_KEY_PRIVATE_KEY is required');

  const chain = resolveChain(env.CORK_CHAIN_ID);
  const rpcUrl = env.CORK_RPC_URL ?? env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error('CORK_RPC_URL (or BASE_RPC_URL) is required');

  const owner = privateKeyToAccount(env.SHARED_EOA_PRIVATE_KEY as Hex);
  const sessionOwner = getSessionOwner();
  const sdk = getRhinestoneSdk(chain, rpcUrl);

  const account = await buildAccount(owner, chain.id, rpcUrl);
  const accountAddress = account.getAddress();

  console.log('Owner:      ', owner.address);
  console.log('Session key:', sessionOwner.address);
  console.log('Chain:      ', chain.id, chain.name);
  console.log('Salt nonce: ', env.SAFE_SALT_NONCE.toString());
  console.log('Safe:       ', accountAddress);
  console.log('Deployed:   ', await account.isDeployed(chain));

  const session = await buildIntentSession(sdk, chain, env.GUARD_MODULE as `0x${string}`);
  console.log('Permission: ', session.permissionId);

  const enableCall = await buildEnableSessionCall(account, session);

  console.log('\nSending sponsored userOp (deploy + modules + enable session)...');
  const { txHash } = await executeSponsored(account, chain, [enableCall]);

  console.log('tx:', txHash);
  console.log('\nDone.');
  console.log('  account:     ', accountAddress);
  console.log('  permissionId:', session.permissionId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
