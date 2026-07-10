import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Address } from 'viem/account-abstraction';
import { arbitrum } from 'viem/chains';
import { createSmartAccountClient, type SmartAccountClient } from 'permissionless';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient, type PimlicoClient } from 'permissionless/clients/pimlico';

import { env } from '../config/env.js';
import { logger } from '../logger.js';

const PIMLICO_URL = `https://api.pimlico.io/v2/${arbitrum.id}/rpc?apikey=${env.PIMLICO_API_KEY}`;

export type Call = {
  to: Address;
  value?: bigint;
  data?: Hex;
};

export type WalletInfo = {
  smartWalletAddress: Address;
  ownerAddress: Address;
  chainId: number;
  chainName: string;
  isDeployed: boolean;
};

// Module-level singletons initialized once by `initWallet()`.
let publicClient: PublicClient | undefined;
let pimlicoClient: PimlicoClient | undefined;
// The smart-account client is fully parameterized; we intentionally keep it loosely typed to
// avoid dragging permissionless's deep generic instantiation through the whole app.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let smartAccountClient: SmartAccountClient<any, any, any, any> | undefined;
let ownerAddress: Address | undefined;
let smartWalletAddress: Address | undefined;

/**
 * Initialize the smart wallet stack:
 *  - viem public client on Arbitrum One (Alchemy RPC)
 *  - Pimlico bundler + paymaster client
 *  - Safe 4337 smart account (v1.4.1, EntryPoint v0.7) owned by the shared EOA
 *  - Smart account client wired with the paymaster (all userOps are sponsored)
 *
 * The Safe is intentionally minimal: no Rhinestone attesters, no OwnableValidator module.
 * The shared EOA is the sole owner and signs every userOp.
 */
export async function initWallet(): Promise<WalletInfo> {
  publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(env.ALCHEMY_RPC_URL),
  });

  pimlicoClient = createPimlicoClient({
    transport: http(PIMLICO_URL),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  const owner = privateKeyToAccount(env.SHARED_EOA_PRIVATE_KEY as Hex);
  ownerAddress = owner.address;

  const safeAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [owner],
    version: '1.4.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  smartWalletAddress = safeAccount.address;

  smartAccountClient = createSmartAccountClient({
    account: safeAccount,
    chain: arbitrum,
    bundlerTransport: http(PIMLICO_URL),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient!.getUserOperationGasPrice()).fast,
    },
  });

  const isDeployed = await safeAccount.isDeployed();

  logger.info(
    {
      smartWalletAddress,
      ownerAddress,
      chainId: arbitrum.id,
      chainName: arbitrum.name,
      isDeployed,
    },
    'Smart wallet initialized',
  );

  return {
    smartWalletAddress,
    ownerAddress,
    chainId: arbitrum.id,
    chainName: arbitrum.name,
    isDeployed,
  };
}

function ensureReady(): void {
  if (!smartAccountClient || !smartWalletAddress || !ownerAddress) {
    throw new Error('Wallet service not initialized. Call initWallet() at startup.');
  }
}

/**
 * Return a snapshot of the smart wallet state, including live deployment status.
 */
export async function getWalletInfo(): Promise<WalletInfo> {
  ensureReady();
  const account = smartAccountClient!.account!;
  // `isDeployed` is refetched every call so the field is always up-to-date.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isDeployed = await (account as any).isDeployed();
  return {
    smartWalletAddress: smartWalletAddress!,
    ownerAddress: ownerAddress!,
    chainId: arbitrum.id,
    chainName: arbitrum.name,
    isDeployed,
  };
}

export type SendCallsResult = {
  userOpHash: Hex;
  receipt?: {
    transactionHash: Hex;
    blockNumber: string;
    success: boolean;
  };
};

/**
 * Send an arbitrary batch of calls from the smart wallet. The userOp is sponsored by Pimlico,
 * so the smart wallet does not need to hold ETH. If `waitForReceipt` is true, the promise
 * resolves once the userOp is included on-chain.
 */
export async function sendCalls(calls: Call[], waitForReceipt = false): Promise<SendCallsResult> {
  ensureReady();
  if (calls.length === 0) throw new Error('At least one call is required.');

  const userOpHash = await smartAccountClient!.sendUserOperation({ calls });

  if (!waitForReceipt) {
    return { userOpHash };
  }

  const receipt = await smartAccountClient!.waitForUserOperationReceipt({ hash: userOpHash });
  return {
    userOpHash,
    receipt: {
      transactionHash: receipt.receipt.transactionHash,
      blockNumber: receipt.receipt.blockNumber.toString(),
      success: receipt.success,
    },
  };
}
