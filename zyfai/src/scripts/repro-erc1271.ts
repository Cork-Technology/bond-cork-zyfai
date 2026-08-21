/**
 * Repro: ERC-1271 via smart sessions (SmartSessionEmissary) on Safe 1.4.1 + Safe7579.
 *
 * Same account, same session, same EIP-712 payload, three signature packings:
 *
 *   A. account.signTypedData(typedData, chain, { type: 'session', session })
 *      -> Safe.isValidSignature returns 0xffffffff
 *   B. A, with a mode byte spliced in after the validator address
 *      -> still 0xffffffff (0x01) / reverts (0x00)
 *   C. hand-packed "notarized" blob (the layout the deployed module reads)
 *      -> Safe.isValidSignature returns 0x1626ba7e
 *
 * Two independent gaps, hence B:
 *
 *   1. `signRuntimeTypedData` emits validator ‖ permissionId ‖ erc7739Signature
 *      with no smart-session mode byte. `signRuntimeMessage` does emit one, via
 *      `mode: 'notarized'`; the typed-data path has no equivalent.
 *   2. `resolveSessionData` hardcodes
 *      `allowedERC7739Content: [{ contentNames: [''], appDomainSeparator: zeroHash }]`
 *      and `createSession` exposes no way to override it, so the ERC-7739 branch
 *      can never match a real app domain. The script reads that allowlist back
 *      from the module to show it.
 *
 * The payload is a 1inch Limit Order Protocol v4 order, the case that motivated
 * this: the Safe is the maker, and the taker settles through
 * fillContractOrder -> Safe.isValidSignature.
 *
 * Env: BASE_RPC_URL, RHINESTONE_API_KEY, PIMLICO_API_KEY,
 *      SHARED_EOA_PRIVATE_KEY, SESSION_KEY_PRIVATE_KEY, GUARD_MODULE, SAFE_SALT_NONCE
 *
 * Usage: npx tsx src/scripts/repro-erc1271.ts
 */
import {
  concat,
  createPublicClient,
  encodeAbiParameters,
  hashDomain,
  hashMessage,
  hashTypedData,
  http,
  keccak256,
  numberToHex,
  size,
  slice,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { Address, Hex } from 'viem';

import { env } from '../config/env.js';
import { buildIntentSession } from '../services/intent-session.js';
import { buildAccount, getRhinestoneSdk } from '../services/rhinestone.js';

const ERC1271_MAGIC = '0x1626ba7e';
const ERC1271_FAIL = '0xffffffff';
const MODE_DIRECT = '0x00';
const SMART_SESSION_EMISSARY: Address = '0xad568B3F825A8d5FFc06DD3253526B64D810Ae89';
const LOP_V4: Address = '0x111111125421cA6dc452d289314280a0f8842A65';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

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

const ERC7739_CONTENT_ABI = [
  {
    type: 'function',
    name: 'getEnabledERC7739Content',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'permissionId', type: 'bytes32' },
    ],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'appDomainSeparator', type: 'bytes32' },
          { name: 'contentNameHashes', type: 'bytes32[]' },
        ],
      },
    ],
  },
] as const;

function lopOrderTypedData(maker: Address) {
  return {
    domain: {
      name: '1inch Aggregation Router',
      version: '6',
      chainId: base.id,
      verifyingContract: LOP_V4,
    },
    types: {
      Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'receiver', type: 'address' },
        { name: 'makerAsset', type: 'address' },
        { name: 'takerAsset', type: 'address' },
        { name: 'makingAmount', type: 'uint256' },
        { name: 'takingAmount', type: 'uint256' },
        { name: 'makerTraits', type: 'uint256' },
      ],
    },
    primaryType: 'Order',
    message: {
      salt: 1n,
      maker,
      receiver: maker,
      makerAsset: USDC,
      takerAsset: USDC,
      makingAmount: 1_000_000n,
      takingAmount: 1_000_000n,
      makerTraits: 0n,
    },
  } as const;
}

async function main(): Promise<void> {
  const rpcUrl = env.CORK_RPC_URL ?? env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error('BASE_RPC_URL is required');
  if (!env.SESSION_KEY_PRIVATE_KEY) throw new Error('SESSION_KEY_PRIVATE_KEY is required');

  const owner = privateKeyToAccount(env.SHARED_EOA_PRIVATE_KEY as Hex);
  const sessionKey = privateKeyToAccount(env.SESSION_KEY_PRIVATE_KEY as Hex);
  const sdk = getRhinestoneSdk(base, rpcUrl);
  const account = await buildAccount(owner, base.id, rpcUrl);
  const session = await buildIntentSession(sdk, base, env.GUARD_MODULE as Address);
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const safe = account.getAddress();
  const typedData = lopOrderTypedData(safe);
  const orderHash = hashTypedData(typedData);

  console.log('safe          ', safe);
  console.log('session key   ', sessionKey.address);
  console.log('permissionId  ', session.permissionId);
  console.log('emissary      ', SMART_SESSION_EMISSARY);
  console.log('session live  ', await account.isSessionEnabled(session));
  console.log('orderHash     ', orderHash);

  const check = async (label: string, signature: Hex): Promise<Hex> => {
    const answer = await publicClient
      .readContract({
        address: safe,
        abi: IS_VALID_SIGNATURE_ABI,
        functionName: 'isValidSignature',
        args: [orderHash, signature],
      })
      .catch((error: unknown) => `revert: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` as Hex);

    console.log(`\n--- ${label} ---`);
    console.log(`bytes         ${size(signature)}`);
    console.log(`validator     ${slice(signature, 0, 20)}`);
    console.log(`next byte     ${slice(signature, 20, 21)}`);
    console.log(`blob          ${signature}`);
    console.log(`isValidSignature -> ${answer}`);
    return answer;
  };

  // What the module will accept on the ERC-7739 branch, read back from storage.
  const allowed = await publicClient.readContract({
    address: SMART_SESSION_EMISSARY,
    abi: ERC7739_CONTENT_ABI,
    functionName: 'getEnabledERC7739Content',
    args: [safe, session.permissionId],
  });
  console.log('\nallowed ERC-7739 content (from the module):');
  for (const entry of allowed) {
    console.log(`  appDomainSeparator ${entry.appDomainSeparator}`);
    console.log(`  contentNameHashes  ${entry.contentNameHashes.join(', ')}`);
    console.log(`  (keccak256("")     ${keccak256('0x')})`);
  }
  console.log(`  order domain sep.  ${hashDomain({ domain: { ...typedData.domain, chainId: BigInt(base.id) }, types: { EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ] } })}`);
  console.log(`  order content name "${typedData.primaryType}"`);

  // A — SDK path
  const sdkSignature = await account.signTypedData(typedData, base, { type: 'session', session });
  const sdkAnswer = await check('A. SDK account.signTypedData (session)', sdkSignature);

  // B — same blob, mode byte spliced in after the 20-byte validator address.
  for (const mode of ['0x00', '0x01'] as const) {
    const patched = concat([slice(sdkSignature, 0, 20), mode, slice(sdkSignature, 20)]);
    await check(`B. SDK blob + mode ${mode}`, patched);
  }

  // C — hand-packed notarized:
  //   [20] validator | [1] mode 0x00 | [32] permissionId | [32] offset | [65] ECDSA | policy data
  // Direct mode signs an account-bound digest, not the raw hash.
  const bound = encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [safe, orderHash]);
  const inner = await sessionKey.sign({ hash: hashMessage({ raw: bound }) });
  const manualSignature = concat([
    SMART_SESSION_EMISSARY,
    MODE_DIRECT,
    session.permissionId,
    numberToHex(64 + size(inner), { size: 32 }),
    inner,
  ]);
  const manualAnswer = await check('C. hand-packed notarized', manualSignature);

  console.log('\n=== summary ===');
  console.log(`A (SDK)         ${sdkAnswer}  ${sdkAnswer === ERC1271_FAIL ? '(reproduced)' : ''}`);
  console.log(`C (hand-packed) ${manualAnswer}  ${manualAnswer === ERC1271_MAGIC ? '(accepted)' : ''}`);
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
