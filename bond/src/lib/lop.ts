// Byte plumbing for 1inch LOP v4 coverage orders.
// Adapted from cork/docs/examples/lib.mjs — kept in sync with ExtensionLib,
// MakerTraitsLib, TakerTraitsLib, and OrderLib.

import {
  type Hex,
  concatHex,
  keccak256,
  toHex,
  pad,
  slice,
  hexToBigInt,
} from 'viem';

export const LOP_ADDRESS: Hex = '0x111111125421cA6dc452d289314280a0f8842A65';

export interface ExtensionInputs {
  makingAmountData?: Hex;
  takingAmountData?: Hex;
  preInteractionData?: Hex;
  postInteractionData?: Hex;
}

export function packTargetAndData(target: Hex, extraDataHex?: Hex): Hex {
  return concatHex([target, extraDataHex ?? '0x']);
}

export function buildExtension({
  makingAmountData = '0x',
  takingAmountData = '0x',
  preInteractionData = '0x',
  postInteractionData = '0x',
}: ExtensionInputs = {}): Hex {
  const fields: Hex[] = [
    '0x', // MakerAssetSuffix
    '0x', // TakerAssetSuffix
    makingAmountData,
    takingAmountData,
    '0x', // Predicate
    '0x', // MakerPermit
    preInteractionData,
    postInteractionData,
  ];
  const byteLen = (hex: Hex): number => (hex.length - 2) / 2;
  if (fields.every((f) => byteLen(f) === 0)) return '0x';

  let offsets = 0n;
  let cumulative = 0n;
  fields.forEach((field, i) => {
    cumulative += BigInt(byteLen(field));
    offsets |= cumulative << (32n * BigInt(i));
  });
  return concatHex([pad(toHex(offsets), { size: 32 }), ...fields]);
}

export function saltForExtension(extensionHex: Hex, entropy = BigInt(Date.now())): bigint {
  const MASK160 = (1n << 160n) - 1n;
  const commitment = hexToBigInt(keccak256(extensionHex)) & MASK160;
  return ((entropy & ((1n << 96n) - 1n)) << 160n) | commitment;
}

export interface MakerTraitsInputs {
  expiry?: number;
  nonce?: bigint;
  allowPartialFills?: boolean;
  allowMultipleFills?: boolean;
  hasExtension?: boolean;
  preInteraction?: boolean;
  usePermit2?: boolean;
}

export function buildMakerTraits({
  expiry = 0,
  nonce = 0n,
  allowPartialFills = true,
  allowMultipleFills = true,
  hasExtension = false,
  preInteraction = false,
  usePermit2 = false,
}: MakerTraitsInputs = {}): bigint {
  let traits = 0n;
  if (!allowPartialFills) traits |= 1n << 255n;
  if (allowMultipleFills) traits |= 1n << 254n;
  if (preInteraction) traits |= 1n << 252n;
  if (hasExtension) traits |= 1n << 249n;
  if (usePermit2) traits |= 1n << 248n;
  traits |= (BigInt(expiry) & ((1n << 40n) - 1n)) << 80n;
  traits |= (BigInt(nonce) & ((1n << 40n) - 1n)) << 120n;
  return traits;
}

export function orderExpiry(lifetimeSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + lifetimeSeconds;
}

export function expiryOf(makerTraits: bigint): number {
  return Number((makerTraits >> 80n) & ((1n << 40n) - 1n));
}

export interface TakerTraitsInputs {
  makerAmount?: boolean;
  threshold?: bigint;
  extensionHex?: Hex;
  interactionHex?: Hex;
  target?: Hex | null;
}

export interface TakerTraits {
  traits: bigint;
  args: Hex;
}

export function buildTakerTraits({
  makerAmount = true,
  threshold = 0n,
  extensionHex = '0x',
  interactionHex = '0x',
  target = null,
}: TakerTraitsInputs = {}): TakerTraits {
  let traits = threshold & ((1n << 185n) - 1n);
  if (makerAmount) traits |= 1n << 255n;
  const extLen = BigInt((extensionHex.length - 2) / 2);
  const intLen = BigInt((interactionHex.length - 2) / 2);
  traits |= extLen << 224n;
  traits |= intLen << 200n;
  let args: Hex = '0x';
  if (target) {
    traits |= 1n << 251n;
    args = concatHex([target, extensionHex, interactionHex]);
  } else {
    args = concatHex([extensionHex, interactionHex]);
  }
  return { traits, args };
}

export interface OrderMessage {
  salt: bigint;
  maker: Hex;
  receiver: Hex;
  makerAsset: Hex;
  takerAsset: Hex;
  makingAmount: bigint;
  takingAmount: bigint;
  makerTraits: bigint;
}

const ORDER_EIP712_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'makerAsset', type: 'address' },
    { name: 'takerAsset', type: 'address' },
    { name: 'makingAmount', type: 'uint256' },
    { name: 'takingAmount', type: 'uint256' },
    { name: 'makerTraits', type: 'uint256' },
  ] as const,
} as const;

export function orderTypedData(chainId: number, order: OrderMessage) {
  return {
    domain: {
      name: '1inch Aggregation Router',
      version: '6',
      chainId,
      verifyingContract: LOP_ADDRESS,
    },
    types: ORDER_EIP712_TYPES,
    primaryType: 'Order' as const,
    message: order,
  };
}

export interface CompactSignature {
  r: Hex;
  vs: Hex;
}

export function toCompactSignature(signature65: Hex): CompactSignature {
  const r = slice(signature65, 0, 32);
  const s = hexToBigInt(slice(signature65, 32, 64));
  const v = hexToBigInt(slice(signature65, 64, 65));
  const vs = toHex(((v - 27n) << 255n) | s, { size: 32 });
  return { r, vs };
}

export const FILL_CONTRACT_ORDER_ARGS_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'salt', type: 'uint256' },
          { name: 'maker', type: 'uint256' },
          { name: 'receiver', type: 'uint256' },
          { name: 'makerAsset', type: 'uint256' },
          { name: 'takerAsset', type: 'uint256' },
          { name: 'makingAmount', type: 'uint256' },
          { name: 'takingAmount', type: 'uint256' },
          { name: 'makerTraits', type: 'uint256' },
        ],
        name: 'order',
        type: 'tuple',
      },
      { name: 'signature', type: 'bytes' },
      { name: 'amount', type: 'uint256' },
      { name: 'takerTraits', type: 'uint256' },
      { name: 'args', type: 'bytes' },
    ],
    name: 'fillContractOrderArgs',
    outputs: [
      { name: 'makingAmount', type: 'uint256' },
      { name: 'takingAmount', type: 'uint256' },
      { name: 'orderHash', type: 'bytes32' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const FILL_ORDER_ARGS_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'salt', type: 'uint256' },
          { name: 'maker', type: 'uint256' },
          { name: 'receiver', type: 'uint256' },
          { name: 'makerAsset', type: 'uint256' },
          { name: 'takerAsset', type: 'uint256' },
          { name: 'makingAmount', type: 'uint256' },
          { name: 'takingAmount', type: 'uint256' },
          { name: 'makerTraits', type: 'uint256' },
        ],
        name: 'order',
        type: 'tuple',
      },
      { name: 'r', type: 'bytes32' },
      { name: 'vs', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'takerTraits', type: 'uint256' },
      { name: 'args', type: 'bytes' },
    ],
    name: 'fillOrderArgs',
    outputs: [
      { name: 'makingAmount', type: 'uint256' },
      { name: 'takingAmount', type: 'uint256' },
      { name: 'orderHash', type: 'bytes32' },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export const KNOWN_ERRORS_ABI = [
  { type: 'error', name: 'BadSignature', inputs: [] },
  { type: 'error', name: 'OrderExpired', inputs: [] },
  { type: 'error', name: 'InvalidatedOrder', inputs: [] },
  { type: 'error', name: 'TakingAmountTooHigh', inputs: [] },
  { type: 'error', name: 'MakingAmountTooLow', inputs: [] },
  { type: 'error', name: 'TakingAmountExceeded', inputs: [] },
  { type: 'error', name: 'PartialFillNotAllowed', inputs: [] },
  { type: 'error', name: 'SwapWithZeroAmount', inputs: [] },
  { type: 'error', name: 'PrivateOrder', inputs: [] },
  { type: 'error', name: 'TransferFromMakerToTakerFailed', inputs: [] },
  { type: 'error', name: 'TransferFromTakerToMakerFailed', inputs: [] },
  { type: 'error', name: 'MissingOrderExtension', inputs: [] },
  { type: 'error', name: 'UnexpectedOrderExtension', inputs: [] },
  { type: 'error', name: 'InvalidExtensionHash', inputs: [] },
  { type: 'error', name: 'ReentrancyDetected', inputs: [] },
  { type: 'error', name: 'OnlyLimitOrderProtocol', inputs: [] },
  { type: 'error', name: 'OrderNotForPool', inputs: [] },
  { type: 'error', name: 'MintUnavailable', inputs: [] },
  { type: 'error', name: 'MintAmountDrift', inputs: [] },
] as const;


// ABI slices with the known custom errors appended so viem can decode reverts
// such as TransferFromMakerToTakerFailed instead of printing raw 4-byte selectors.
export const FILL_CONTRACT_ORDER_ARGS_ABI_WITH_ERRORS = [
  ...FILL_CONTRACT_ORDER_ARGS_ABI,
  ...KNOWN_ERRORS_ABI,
] as const;

export const FILL_ORDER_ARGS_ABI_WITH_ERRORS = [
  ...FILL_ORDER_ARGS_ABI,
  ...KNOWN_ERRORS_ABI,
] as const;
