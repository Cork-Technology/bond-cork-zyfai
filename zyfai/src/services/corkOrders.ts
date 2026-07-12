import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  hexToBigInt,
  http,
  isAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { env } from '../config/env.js';
import { sendCalls, type Call } from './wallet.js';

const LOP_ADDRESS: Address = '0x111111125421cA6dc452d289314280a0f8842A65';
const SAFE_MSG_TYPEHASH: Hex = '0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca';
const ORDERBOOK_URL = env.ORDERBOOK_URL ?? 'https://api-phoenix.cork.tech';

export type OrderMessage = {
  salt: bigint;
  maker: Address;
  receiver: Address;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: bigint;
  takingAmount: bigint;
  makerTraits: bigint;
};

export type PostBidParams = {
  poolId: Hex;
  ca: Address;
  cst: Address;
  caDecimals: number;
  sizeCst: bigint;
  priceCaPerCst: number;
  premiumDisplay?: number;
  expirySeconds?: number;
};

function buildMakerTraits({
  expiry = 0,
  nonce = 0n,
  allowPartialFills = true,
  allowMultipleFills = true,
}: {
  expiry?: number;
  nonce?: bigint;
  allowPartialFills?: boolean;
  allowMultipleFills?: boolean;
}): bigint {
  let traits = 0n;
  if (!allowPartialFills) traits |= 1n << 255n;
  if (allowMultipleFills) traits |= 1n << 254n;
  traits |= (BigInt(expiry) & ((1n << 40n) - 1n)) << 80n;
  traits |= (BigInt(nonce) & ((1n << 40n) - 1n)) << 120n;
  return traits;
}

function orderExpiry(lifetimeSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + lifetimeSeconds;
}

function orderTypedData(chainId: number, order: OrderMessage) {
  return {
    domain: {
      name: '1inch Aggregation Router',
      version: '6',
      chainId,
      verifyingContract: LOP_ADDRESS,
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
    primaryType: 'Order' as const,
    message: order,
  };
}

function premiumFromPrice(
  sizeCst: bigint,
  priceCaPerCst: number,
  caDecimals: number,
): bigint {
  const PRICE_SCALE = 1_000_000_000n;
  const priceScaled = BigInt(Math.round(priceCaPerCst * 1e9));
  return (
    (sizeCst * priceScaled * 10n ** BigInt(caDecimals) + (PRICE_SCALE * 10n ** 18n - 1n)) /
    (PRICE_SCALE * 10n ** 18n)
  );
}

export async function postSafeBid(
  params: PostBidParams,
  safeAddress: Address,
  privateKey: Hex,
): Promise<{ orderHash: Hex; signature: Hex }> {
  if (!isAddress(params.ca) || !isAddress(params.cst) || !isAddress(safeAddress)) {
    throw new Error('Invalid address in bid parameters');
  }

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(env.ALCHEMY_RPC_URL) });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiry = orderExpiry(params.expirySeconds ?? 3600, nowSeconds);
  const nonce = BigInt(nowSeconds) & ((1n << 40n) - 1n);
  const makerTraits = buildMakerTraits({ expiry, nonce });
  const premiumCa = premiumFromPrice(params.sizeCst, params.priceCaPerCst, params.caDecimals);

  const order: OrderMessage = {
    salt: BigInt(Date.now()),
    maker: safeAddress,
    receiver: '0x0000000000000000000000000000000000000000',
    makerAsset: params.ca,
    takerAsset: params.cst,
    makingAmount: premiumCa,
    takingAmount: params.sizeCst,
    makerTraits,
  };

  const typed = orderTypedData(arbitrum.id, order);
  const orderHash = hashTypedData(typed);

  const domainSeparator = await publicClient.readContract({
    address: safeAddress,
    abi: parseAbi(['function domainSeparator() view returns (bytes32)']),
    functionName: 'domainSeparator',
  });

  const safeMessageHash = keccak256(
    concatHex([
      '0x1901',
      domainSeparator,
      keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes32' }],
          [SAFE_MSG_TYPEHASH, keccak256(orderHash)],
        ),
      ),
    ]),
  );

  const signature = await account.sign({ hash: safeMessageHash });

  const payload = {
    salt: order.salt.toString(),
    maker: order.maker,
    receiver: order.receiver,
    makerAsset: order.makerAsset,
    takerAsset: order.takerAsset,
    makingAmount: premiumCa.toString(),
    takingAmount: params.sizeCst.toString(),
    makerTraits: makerTraits.toString(),
    orderHash,
    signature,
    makerAccountType: 'CONTRACT',
    makerPermit2: '',
    extension: '',
    side: 'BUY',
    premium: params.premiumDisplay ?? 0,
    expiry,
    nonce: nonce.toString(),
    allowsPartialFills: true,
    chainId: arbitrum.id,
    poolId: params.poolId,
  };

  const res = await fetch(`${ORDERBOOK_URL}/v1/limit-orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { orderHash?: Hex; message?: string; error?: string };
  if (!res.ok) {
    throw new Error(`Phoenix POST failed: ${res.status} ${body.message ?? body.error ?? JSON.stringify(body)}`);
  }
  if (!body.orderHash) {
    throw new Error('Phoenix POST returned no orderHash');
  }
  return { orderHash: body.orderHash, signature };
}

export type ApiOrder = {
  orderHash: Hex;
  salt: string;
  maker: Address;
  receiver: Address;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: string;
  takingAmount: string;
  makerTraits: string;
  signature: Hex;
  makerAccountType: 'EOA' | 'CONTRACT';
  extension: Hex;
  side: 'BUY' | 'SELL';
  premium: number;
  expiry: number;
  nonce: string;
  status: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
  remainingMakingAmount: string;
  remainingTakingAmount: string;
};

export async function listSafeOrders(
  safeAddress: Address,
  poolId?: Hex,
  side?: 'BUY' | 'SELL',
): Promise<ApiOrder[]> {
  const url = new URL(`${ORDERBOOK_URL}/v1/limit-orders/orderbook`);
  url.searchParams.set('chainId', '42161');
  if (poolId) url.searchParams.set('poolId', poolId);
  if (side) url.searchParams.set('side', side);
  url.searchParams.set('status', 'OPEN');
  url.searchParams.set('status', 'PARTIALLY_FILLED');

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Phoenix orderbook fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as { items: ApiOrder[] };
  const safeLower = safeAddress.toLowerCase();
  return data.items.filter((o) => o.maker.toLowerCase() === safeLower);
}

export type CancelOrderInput = {
  salt: bigint;
  maker: Address;
  receiver: Address;
  makerAsset: Address;
  takerAsset: Address;
  makingAmount: bigint;
  takingAmount: bigint;
  makerTraits: bigint;
};

export async function cancelSafeOrder(
  order: CancelOrderInput,
): Promise<{ userOpHash: Hex; txHash?: Hex }> {
  if (!isAddress(order.maker)) throw new Error('Invalid maker address');

  const data = encodeFunctionData({
    abi: parseAbi([
      'function cancelOrder((uint256 salt, uint256 maker, uint256 receiver, uint256 makerAsset, uint256 takerAsset, uint256 makingAmount, uint256 takingAmount, uint256 makerTraits) order) returns (bytes32 orderHash)',
    ]),
    functionName: 'cancelOrder',
    args: [
      {
        salt: order.salt,
        maker: hexToBigInt(order.maker),
        receiver: hexToBigInt(order.receiver),
        makerAsset: hexToBigInt(order.makerAsset),
        takerAsset: hexToBigInt(order.takerAsset),
        makingAmount: order.makingAmount,
        takingAmount: order.takingAmount,
        makerTraits: order.makerTraits,
      },
    ],
  });

  const calls: Call[] = [{ to: LOP_ADDRESS, value: 0n, data }];
  const result = await sendCalls(calls, true);
  return {
    userOpHash: result.userOpHash,
    txHash: result.receipt?.transactionHash,
  };
}
