import { hashTypedData, hexToBigInt, type Hex } from 'viem';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import {
  FILL_CONTRACT_ORDER_ARGS_ABI_WITH_ERRORS,
  FILL_ORDER_ARGS_ABI_WITH_ERRORS,
  type OrderMessage,
  type TakerTraits,
  buildExtension,
  buildMakerTraits,
  buildTakerTraits,
  orderExpiry,
  orderTypedData,
  packTargetAndData,
  saltForExtension,
  toCompactSignature,
} from '../lib/lop.js';
import { postOrder, type OrderItem, type PostOrderPayload } from './cork.js';
import { publicClient, walletClient, account, BOND_ADDRESS, lopAbi, erc20Abi } from './chain.js';
import { premiumToTakingAmount } from './pricing.js';

let nonceCounter = 0;

export function nextNonce(): bigint {
  const now = BigInt(Math.floor(Date.now() / 1000)) & ((1n << 40n) - 1n);
  nonceCounter += 1;
  return (now << 10n) | BigInt(nonceCounter % 1024);
}

export function orderFromApi(item: OrderItem): OrderMessage {
  return {
    salt: BigInt(item.salt),
    maker: item.maker,
    receiver: item.receiver,
    makerAsset: item.makerAsset,
    takerAsset: item.takerAsset,
    makingAmount: BigInt(item.makingAmount),
    takingAmount: BigInt(item.takingAmount),
    makerTraits: BigInt(item.makerTraits),
  };
}

export function orderToContractArgs(order: OrderMessage) {
  return {
    salt: order.salt,
    maker: hexToBigInt(order.maker),
    receiver: hexToBigInt(order.receiver),
    makerAsset: hexToBigInt(order.makerAsset),
    takerAsset: hexToBigInt(order.takerAsset),
    makingAmount: order.makingAmount,
    takingAmount: order.takingAmount,
    makerTraits: order.makerTraits,
  };
}

export function buildLiftTakerTraits(
  bid: OrderItem,
  adapter: Hex,
  poolId: Hex,
  _amountCst: bigint,
): TakerTraits {
  // For a BUY bid, taker delivers cST (takingAmount). Use makerAmount:false so
  // `amount` is the cST we deliver. Threshold 0 matches the reference example:
  // the signed price is static, and floor checks happen off-chain.
  return buildTakerTraits({
    makerAmount: false,
    threshold: 0n,
    extensionHex: bid.extension,
    interactionHex: packTargetAndData(adapter, poolId),
  });
}

export async function liftBid(
  bid: OrderItem,
  poolId: Hex,
  amountCst: bigint,
): Promise<Hex> {
  const order = orderFromApi(bid);
  const orderArgs = orderToContractArgs(order);
  const { traits, args } = buildLiftTakerTraits(bid, env.CORK_LIMIT_ORDER_ADAPTER, poolId, amountCst);

  if (bid.makerAccountType === 'CONTRACT') {
    // Preflight: the contract maker must have approved the LOP to pull the CA
    // premium. A missing approval reverts TransferFromMakerToTakerFailed.
    const makerAllowance = await publicClient.readContract({
      address: order.makerAsset,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [order.maker, env.ONE_INCH_LOP_V4],
    });
    if (makerAllowance < order.makingAmount) {
      throw new Error(
        `maker CA allowance insufficient: ${makerAllowance} < ${order.makingAmount}`,
      );
    }

    const { request } = await publicClient.simulateContract({
      address: env.ONE_INCH_LOP_V4,
      abi: FILL_CONTRACT_ORDER_ARGS_ABI_WITH_ERRORS,
      functionName: 'fillContractOrderArgs',
      args: [orderArgs, bid.signature, amountCst, traits, args],
      account: BOND_ADDRESS,
    });
    const hash = await walletClient.writeContract({ ...request, account });
    logger.info({ orderHash: bid.orderHash, txHash: hash }, 'lifted CONTRACT bid');
    return hash;
  }

  const { r, vs } = toCompactSignature(bid.signature);
  const { request } = await publicClient.simulateContract({
    address: env.ONE_INCH_LOP_V4,
    abi: FILL_ORDER_ARGS_ABI_WITH_ERRORS,
    functionName: 'fillOrderArgs',
    args: [orderArgs, r, vs, amountCst, traits, args],
    account: BOND_ADDRESS,
  });
  const hash = await walletClient.writeContract({ ...request, account });
  logger.info({ orderHash: bid.orderHash, txHash: hash }, 'lifted EOA bid');
  return hash;
}

export interface CounterAskInputs {
  poolId: Hex;
  sizeCst: bigint;
  premiumBps: number;
  lifetimeSeconds?: number;
}

export function buildCounterAskOrder({
  poolId,
  sizeCst,
  premiumBps,
  lifetimeSeconds = env.ORDER_LIFETIME_SECONDS,
}: CounterAskInputs): { order: OrderMessage; extension: Hex; nonce: bigint; expiry: number } {
  const extension = buildExtension({
    preInteractionData: packTargetAndData(env.CORK_LIMIT_ORDER_ADAPTER, poolId),
  });
  const expiry = orderExpiry(lifetimeSeconds);
  const nonce = nextNonce();
  const makerTraits = buildMakerTraits({
    expiry,
    nonce,
    allowPartialFills: true,
    allowMultipleFills: true,
    hasExtension: true,
    preInteraction: true,
    usePermit2: false,
  });

  const takingAmount = premiumToTakingAmount(sizeCst, premiumBps);

  const order: OrderMessage = {
    salt: saltForExtension(extension),
    maker: BOND_ADDRESS,
    receiver: '0x0000000000000000000000000000000000000000',
    makerAsset: '0x0000000000000000000000000000000000000000', // filled in by caller with cST
    takerAsset: env.CA_TOKEN,
    makingAmount: sizeCst,
    takingAmount,
    makerTraits,
  };

  return { order, extension, nonce, expiry };
}

export async function signAndPostCounterAsk(
  pool: { poolId: Hex; swapToken: { address: Hex } },
  inputs: CounterAskInputs,
): Promise<{ orderHash: Hex; txHash?: Hex }> {
  const { order, extension, nonce, expiry } = buildCounterAskOrder(inputs);
  order.makerAsset = pool.swapToken.address;

  const typed = orderTypedData(42161, order);
  const signature = await walletClient.signTypedData(typed);
  const orderHash = hashTypedData(typed);

  // Cross-check on-chain.
  const onchain = await publicClient.readContract({
    address: env.ONE_INCH_LOP_V4,
    abi: lopAbi,
    functionName: 'hashOrder',
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
  if (orderHash !== onchain) {
    throw new Error(`EIP-712 hash mismatch: local=${orderHash} onchain=${onchain}`);
  }

  const payload: PostOrderPayload = {
    salt: order.salt.toString(),
    maker: order.maker,
    receiver: order.receiver,
    makerAsset: order.makerAsset,
    takerAsset: order.takerAsset,
    makingAmount: order.makingAmount.toString(),
    takingAmount: order.takingAmount.toString(),
    makerTraits: order.makerTraits.toString(),
    orderHash,
    signature,
    makerAccountType: 'EOA',
    makerPermit2: '',
    extension,
    side: 'SELL',
    premium: inputs.premiumBps,
    expiry,
    nonce: nonce.toString(),
    allowsPartialFills: true,
    chainId: 42161,
  };

  const res = await postOrder(payload);
  logger.info(
    { orderHash, postedHash: res.orderHash, poolId: pool.poolId, premiumBps: inputs.premiumBps },
    'posted counter SELL ask',
  );
  return { orderHash, txHash: undefined };
}
