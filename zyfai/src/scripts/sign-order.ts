/**
 * Sign a Cork maker-order with the SESSION KEY and verify the resulting
 * ERC-1271 signature against the Safe.
 *
 * The Rhinestone SDK's `signTypedData` packs session signatures for an older
 * SmartSession layout and is rejected by the deployed SmartSessionEmissary, so
 * the blob is assembled here in the layout that module actually reads:
 *
 *   [20] validator address      consumed by Safe7579's fallback dispatch
 *   [ 1] signature mode         0x00 = direct (appDomainSeparator == 0)
 *   [32] permissionId
 *   [32] policyDataOffset       absolute offset into the post-mode slice
 *   [65] session key signature  slice [64:policyDataOffset]
 *        policy data            slice [policyDataOffset:] — empty for SudoPolicy
 *
 * Direct mode signs an account-bound digest rather than the raw hash:
 * toEthSignedMessageHash(abi.encode(account, hash)).
 *
 * Usage:
 *   npx tsx src/scripts/sign-order.ts <prepared.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { concat, encodeAbiParameters, hashMessage, hashTypedData, numberToHex, size } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

import { env } from '../config/env.js';
import { createSessionContext } from '../services/session.js';

const ERC1271_MAGIC = '0x1626ba7e';
const MODE_DIRECT = '0x00';
const SMART_SESSION_EMISSARY: Address = '0xad568B3F825A8d5FFc06DD3253526B64D810Ae89';

const IS_VALID_SIGNATURE_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const;

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('usage: sign-order.ts <prepared.json>');

  const prepared = JSON.parse(readFileSync(path, 'utf8')) as {
    data?: { typedData: Parameters<typeof hashTypedData>[0]; orderHash: Hex };
  };
  if (!prepared.data) throw new Error('not a prepared maker order');
  const { typedData, orderHash } = prepared.data;

  if (hashTypedData(typedData).toLowerCase() !== orderHash.toLowerCase()) {
    throw new Error(`orderHash mismatch: cork ${orderHash} vs local ${hashTypedData(typedData)}`);
  }

  const rpcUrl = env.CORK_RPC_URL ?? env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error('CORK_RPC_URL or BASE_RPC_URL is required');
  if (!env.SESSION_KEY_PRIVATE_KEY) throw new Error('SESSION_KEY_PRIVATE_KEY is required');

  const ctx = await createSessionContext({ chainId: env.CORK_CHAIN_ID, rpcUrl });
  const sessionKey = privateKeyToAccount(env.SESSION_KEY_PRIVATE_KEY as Hex);

  const bound = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }],
    [ctx.safeAddress, orderHash],
  );
  const inner = await sessionKey.sign({ hash: hashMessage({ raw: bound }) });

  const signature = concat([
    SMART_SESSION_EMISSARY,
    MODE_DIRECT,
    ctx.permissionId,
    numberToHex(64 + size(inner), { size: 32 }),
    inner,
  ]);

  console.log(`orderHash  ${orderHash}`);
  console.log(`safe       ${ctx.safeAddress}`);
  console.log(`signer     ${sessionKey.address} (session key)`);
  console.log(`signature  ${size(signature)} bytes`);

  const answer = await ctx.publicClient.readContract({
    address: ctx.safeAddress,
    abi: IS_VALID_SIGNATURE_ABI,
    functionName: 'isValidSignature',
    args: [orderHash, signature],
  });
  console.log(`isValidSignature -> ${answer}`);
  if (answer !== ERC1271_MAGIC) throw new Error(`ERC-1271 rejected (expected ${ERC1271_MAGIC})`);

  const out = `${path.replace(/\.json$/u, '')}.sig.json`;
  writeFileSync(out, JSON.stringify({ orderHash, signature }));
  console.log(`\nOK — ${out}`);
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
