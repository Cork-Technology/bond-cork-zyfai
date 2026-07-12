import {
  hashTypedData,
  keccak256,
  parseUnits,
  formatUnits,
  concatHex,
  pad,
  toHex,
  hexToBigInt,
  slice,
  type Hex,
  type Address,
} from "viem";
import { CHAIN_ID, CONTRACTS } from "@/lib/constants";
import type { PhoenixPool, LimitOrder } from "@/lib/types";

const LOP_ADDRESS = CONTRACTS.LOP;

function getBaseUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001";
}

export function packTargetAndData(target: Address, extraDataHex: Hex = "0x"): Hex {
  return concatHex([target, extraDataHex]);
}

export function buildExtension({
  makingAmountData = "0x",
  takingAmountData = "0x",
  preInteractionData = "0x",
  postInteractionData = "0x",
}: {
  makingAmountData?: Hex;
  takingAmountData?: Hex;
  preInteractionData?: Hex;
  postInteractionData?: Hex;
} = {}): Hex {
  const fields: Hex[] = [
    "0x", // MakerAssetSuffix
    "0x", // TakerAssetSuffix
    makingAmountData,
    takingAmountData,
    "0x", // Predicate
    "0x", // MakerPermit
    preInteractionData,
    postInteractionData,
  ];
  const byteLen = (hex: Hex) => (hex.length - 2) / 2;
  if (fields.every((f) => byteLen(f) === 0)) return "0x";

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

function buildMakerTraits({
  expiry = 0,
  nonce = 0n,
  allowPartialFills = true,
  allowMultipleFills = true,
  hasExtension = false,
  preInteraction = false,
}: {
  expiry?: number;
  nonce?: bigint;
  allowPartialFills?: boolean;
  allowMultipleFills?: boolean;
  hasExtension?: boolean;
  preInteraction?: boolean;
}): bigint {
  let traits = 0n;
  if (!allowPartialFills) traits |= 1n << 255n;
  if (allowMultipleFills) traits |= 1n << 254n;
  if (preInteraction) traits |= 1n << 252n;
  if (hasExtension) traits |= 1n << 249n;
  traits |= (BigInt(expiry) & ((1n << 40n) - 1n)) << 80n;
  traits |= (BigInt(nonce) & ((1n << 40n) - 1n)) << 120n;
  return traits;
}

function orderExpiry(lifetimeSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + lifetimeSeconds;
}

export function orderTypedData(chainId: number, order: OrderMessage) {
  return {
    domain: {
      name: "1inch Aggregation Router",
      version: "6",
      chainId,
      verifyingContract: LOP_ADDRESS,
    },
    types: {
      Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "receiver", type: "address" },
        { name: "makerAsset", type: "address" },
        { name: "takerAsset", type: "address" },
        { name: "makingAmount", type: "uint256" },
        { name: "takingAmount", type: "uint256" },
        { name: "makerTraits", type: "uint256" },
      ],
    },
    primaryType: "Order" as const,
    message: order,
  };
}

export function orderHash(chainId: number, order: OrderMessage): Hex {
  return hashTypedData(orderTypedData(chainId, order));
}

export function premiumFromPrice(
  sizeCst: bigint,
  priceCaPerCst: number,
  caDecimals: number
): bigint {
  const PRICE_SCALE = 1_000_000_000n;
  const priceScaled = BigInt(Math.round(priceCaPerCst * 1e9));
  return (
    (sizeCst * priceScaled * 10n ** BigInt(caDecimals) + (PRICE_SCALE * 10n ** 18n - 1n)) /
    (PRICE_SCALE * 10n ** 18n)
  );
}

export function buildBidOrder(
  pool: PhoenixPool,
  maker: Address,
  size: string,
  premiumPerCst: string,
  expirySeconds = 3600
): OrderMessage {
  const sizeCst = parseUnits(size, pool.swapToken.decimals);
  const premiumCa = premiumFromPrice(
    sizeCst,
    Number(premiumPerCst),
    pool.collateralToken.decimals
  );
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiry = orderExpiry(expirySeconds, nowSeconds);
  const nonce = BigInt(nowSeconds) & ((1n << 40n) - 1n);

  return {
    salt: BigInt(Date.now()),
    maker,
    receiver: "0x0000000000000000000000000000000000000000",
    makerAsset: pool.collateralToken.address,
    takerAsset: pool.swapToken.address,
    makingAmount: premiumCa,
    takingAmount: sizeCst,
    makerTraits: buildMakerTraits({ expiry, nonce }),
  };
}

export function buildAskOrder(
  pool: PhoenixPool,
  maker: Address,
  size: string,
  premiumPerCst: string,
  expirySeconds = 3600
): { order: OrderMessage; extension: Hex } {
  const sizeCst = parseUnits(size, pool.swapToken.decimals);
  const premiumCa = premiumFromPrice(
    sizeCst,
    Number(premiumPerCst),
    pool.collateralToken.decimals
  );
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiry = orderExpiry(expirySeconds, nowSeconds);
  const nonce = BigInt(nowSeconds) & ((1n << 40n) - 1n);

  const extension = buildExtension({
    preInteractionData: packTargetAndData(CONTRACTS.ADAPTER, pool.poolId as Hex),
  });

  const order: OrderMessage = {
    salt: saltForExtension(extension),
    maker,
    receiver: "0x0000000000000000000000000000000000000000",
    makerAsset: pool.swapToken.address,
    takerAsset: pool.collateralToken.address,
    makingAmount: sizeCst,
    takingAmount: premiumCa,
    makerTraits: buildMakerTraits({
      expiry,
      nonce,
      hasExtension: true,
      preInteraction: true,
    }),
  };

  return { order, extension };
}

export function priceFromPremiumAndSize(
  premiumPerCst: string,
  size: string
): number {
  const sizeNum = Number(size);
  if (sizeNum === 0) return 0;
  return Number(premiumPerCst) / sizeNum;
}

export async function postPhoenixBid(
  pool: PhoenixPool,
  order: OrderMessage,
  signature: Hex,
  premiumDisplay?: number,
  makerAccountType: "EOA" | "CONTRACT" = "EOA"
): Promise<{ orderHash: Hex }> {
  // BUY bids have no extension; Phoenix expects "" not "0x" for empty extension.
  return postPhoenixOrder(pool, order, signature, "BUY", "", premiumDisplay, makerAccountType);
}

export async function postPhoenixAsk(
  pool: PhoenixPool,
  order: OrderMessage,
  signature: Hex,
  extension: Hex,
  premiumDisplay?: number,
  makerAccountType: "EOA" | "CONTRACT" = "EOA"
): Promise<{ orderHash: Hex }> {
  return postPhoenixOrder(pool, order, signature, "SELL", extension, premiumDisplay, makerAccountType);
}

async function postPhoenixOrder(
  pool: PhoenixPool,
  order: OrderMessage,
  signature: Hex,
  side: "BUY" | "SELL",
  extension: Hex | "",
  premiumDisplay?: number,
  makerAccountType: "EOA" | "CONTRACT" = "EOA"
): Promise<{ orderHash: Hex }> {
  const typed = orderTypedData(CHAIN_ID, order);
  const orderHashValue = hashTypedData(typed);
  const nonce = (order.makerTraits >> 120n) & ((1n << 40n) - 1n);
  const expiry = Number((order.makerTraits >> 80n) & ((1n << 40n) - 1n));

  const payload = {
    salt: order.salt.toString(),
    maker: order.maker,
    receiver: order.receiver,
    makerAsset: order.makerAsset,
    takerAsset: order.takerAsset,
    makingAmount: order.makingAmount.toString(),
    takingAmount: order.takingAmount.toString(),
    makerTraits: order.makerTraits.toString(),
    orderHash: orderHashValue,
    signature,
    makerAccountType,
    makerPermit2: "",
    extension,
    side,
    premium: premiumDisplay ?? 0,
    expiry,
    nonce: nonce.toString(),
    allowsPartialFills: true,
    chainId: CHAIN_ID,
    poolId: pool.poolId,
  };

  const res = await fetch(`${getBaseUrl()}/api/bid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { orderHash?: Hex; message?: string; error?: string; details?: Record<string, unknown> };
  if (!res.ok) {
    const detailText = body.details
      ? `\n${JSON.stringify(body.details, null, 2)}`
      : `\n${body.message ?? body.error ?? JSON.stringify(body)}`;
    throw new Error(`Phoenix POST failed: ${res.status}${detailText}`);
  }
  if (!body.orderHash) {
    throw new Error("Phoenix POST returned no orderHash");
  }
  return { orderHash: body.orderHash };
}

function normalizeLimitOrder(raw: LimitOrder): LimitOrder {
  // The Phoenix /orderbook endpoint uses makerAsset/takerAsset,
  // while /fills uses makingAsset/takingAsset. Normalise here so
  // downstream code only has to think in orderbook terms.
  return {
    ...raw,
    makerAsset: (raw.makerAsset ?? (raw as unknown as { makingAsset?: Hex }).makingAsset) as Hex,
    takerAsset: (raw.takerAsset ?? (raw as unknown as { takingAsset?: Hex }).takingAsset) as Hex,
  };
}

export async function fetchOrdersByMaker(
  maker: Hex,
  poolId?: string,
  side?: "BUY" | "SELL"
): Promise<LimitOrder[]> {
  const url = new URL(`${getBaseUrl()}/api/orderbook`);
  url.searchParams.set("chainId", String(CHAIN_ID));
  if (poolId) url.searchParams.set("poolId", poolId);
  if (side) url.searchParams.set("side", side);
  url.searchParams.set("status", "OPEN");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Phoenix orderbook fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as { items: LimitOrder[] };
  const makerLower = maker.toLowerCase();
  return data.items.map(normalizeLimitOrder).filter((o) => o.maker.toLowerCase() === makerLower);
}

export type CancelOrderArgs = {
  salt: bigint;
  maker: bigint;
  receiver: bigint;
  makerAsset: bigint;
  takerAsset: bigint;
  makingAmount: bigint;
  takingAmount: bigint;
  makerTraits: bigint;
};

export function orderToCancelArgs(order: LimitOrder): CancelOrderArgs {
  return {
    salt: safeBigInt(order.salt, "salt"),
    maker: safeBigInt(order.maker, "maker"),
    receiver: 0n,
    makerAsset: safeBigInt(order.makerAsset, "makerAsset"),
    takerAsset: safeBigInt(order.takerAsset, "takerAsset"),
    makingAmount: safeBigInt(order.makingAmount, "makingAmount"),
    takingAmount: safeBigInt(order.takingAmount, "takingAmount"),
    makerTraits: safeBigInt(order.makerTraits, "makerTraits"),
  };
}

// ---------- Taker-side fill helpers for lifting BUY bids ----------

export interface TakerTraits {
  traits: bigint;
  args: Hex;
}

export function buildTakerTraits({
  makerAmount = true,
  threshold = 0n,
  extensionHex = "0x",
  interactionHex = "0x",
  target = null,
}: {
  makerAmount?: boolean;
  threshold?: bigint;
  extensionHex?: Hex;
  interactionHex?: Hex;
  target?: Hex | null;
} = {}): TakerTraits {
  let traits = threshold & ((1n << 185n) - 1n);
  if (makerAmount) traits |= 1n << 255n;
  const extLen = BigInt((extensionHex.length - 2) / 2);
  const intLen = BigInt((interactionHex.length - 2) / 2);
  traits |= extLen << 224n;
  traits |= intLen << 200n;
  let args: Hex = "0x";
  if (target) {
    traits |= 1n << 251n;
    args = concatHex([target, extensionHex, interactionHex]);
  } else {
    args = concatHex([extensionHex, interactionHex]);
  }
  return { traits, args };
}

export function toCompactSignature(signature65: Hex): { r: Hex; vs: Hex } {
  const r = slice(signature65, 0, 32);
  const s = hexToBigInt(slice(signature65, 32, 64));
  const v = hexToBigInt(slice(signature65, 64, 65));
  const vs = toHex(((v - 27n) << 255n) | s, { size: 32 });
  return { r, vs };
}

const KNOWN_FILL_ERRORS = [
  { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "OrderExpired", inputs: [] },
  { type: "error", name: "InvalidatedOrder", inputs: [] },
  { type: "error", name: "TakingAmountTooHigh", inputs: [] },
  { type: "error", name: "MakingAmountTooLow", inputs: [] },
  { type: "error", name: "TakingAmountExceeded", inputs: [] },
  { type: "error", name: "PartialFillNotAllowed", inputs: [] },
  { type: "error", name: "SwapWithZeroAmount", inputs: [] },
  { type: "error", name: "PrivateOrder", inputs: [] },
  { type: "error", name: "TransferFromMakerToTakerFailed", inputs: [] },
  { type: "error", name: "TransferFromTakerToMakerFailed", inputs: [] },
  { type: "error", name: "MissingOrderExtension", inputs: [] },
  { type: "error", name: "UnexpectedOrderExtension", inputs: [] },
  { type: "error", name: "InvalidExtensionHash", inputs: [] },
  { type: "error", name: "ReentrancyDetected", inputs: [] },
  { type: "error", name: "OnlyLimitOrderProtocol", inputs: [] },
  { type: "error", name: "OrderNotForPool", inputs: [] },
  { type: "error", name: "MintUnavailable", inputs: [] },
  { type: "error", name: "MintAmountDrift", inputs: [] },
] as const;

export const FILL_ORDER_ARGS_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "uint256" },
          { name: "receiver", type: "uint256" },
          { name: "makerAsset", type: "uint256" },
          { name: "takerAsset", type: "uint256" },
          { name: "makingAmount", type: "uint256" },
          { name: "takingAmount", type: "uint256" },
          { name: "makerTraits", type: "uint256" },
        ],
        name: "order",
        type: "tuple",
      },
      { name: "r", type: "bytes32" },
      { name: "vs", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "takerTraits", type: "uint256" },
      { name: "args", type: "bytes" },
    ],
    name: "fillOrderArgs",
    outputs: [
      { name: "makingAmount", type: "uint256" },
      { name: "takingAmount", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export const FILL_CONTRACT_ORDER_ARGS_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "uint256" },
          { name: "receiver", type: "uint256" },
          { name: "makerAsset", type: "uint256" },
          { name: "takerAsset", type: "uint256" },
          { name: "makingAmount", type: "uint256" },
          { name: "takingAmount", type: "uint256" },
          { name: "makerTraits", type: "uint256" },
        ],
        name: "order",
        type: "tuple",
      },
      { name: "signature", type: "bytes" },
      { name: "amount", type: "uint256" },
      { name: "takerTraits", type: "uint256" },
      { name: "args", type: "bytes" },
    ],
    name: "fillContractOrderArgs",
    outputs: [
      { name: "makingAmount", type: "uint256" },
      { name: "takingAmount", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ABI slices with the known custom errors appended so viem can decode reverts
// when passed to simulateContract or public read calls.
export const FILL_ORDER_ARGS_ABI_WITH_ERRORS = [
  ...FILL_ORDER_ARGS_ABI,
  ...KNOWN_FILL_ERRORS,
] as const;

export const FILL_CONTRACT_ORDER_ARGS_ABI_WITH_ERRORS = [
  ...FILL_CONTRACT_ORDER_ARGS_ABI,
  ...KNOWN_FILL_ERRORS,
] as const;

export async function fetchBidsForPool(poolId: string): Promise<LimitOrder[]> {
  const url = new URL(`${getBaseUrl()}/api/orderbook`);
  url.searchParams.set("chainId", String(CHAIN_ID));
  url.searchParams.set("poolId", poolId);
  url.searchParams.set("side", "BUY");
  url.searchParams.set("status", "OPEN");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Phoenix orderbook fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as { items: LimitOrder[] };
  return (data.items ?? []).map(normalizeLimitOrder);
}

function safeBigInt(value: string | undefined | null, field: string): bigint {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing order field: ${field}`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid numeric value for ${field}: ${value}`);
  }
}

function orderFromLimitOrder(order: LimitOrder): OrderMessage {
  return {
    salt: safeBigInt(order.salt, "salt"),
    maker: order.maker,
    receiver: "0x0000000000000000000000000000000000000000",
    makerAsset: order.makerAsset,
    takerAsset: order.takerAsset,
    makingAmount: safeBigInt(order.makingAmount, "makingAmount"),
    takingAmount: safeBigInt(order.takingAmount, "takingAmount"),
    makerTraits: safeBigInt(order.makerTraits, "makerTraits"),
  };
}

function orderToContractArgs(order: OrderMessage) {
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
  bid: LimitOrder,
  adapter: Hex,
  poolId: Hex
): TakerTraits {
  return buildTakerTraits({
    makerAmount: false,
    threshold: 0n,
    extensionHex: bid.extension,
    interactionHex: packTargetAndData(adapter, poolId),
  });
}

export type PreparedLiftBid = {
  orderArgs: ReturnType<typeof orderToContractArgs>;
  signature: Hex;
  amount: bigint;
  traits: bigint;
  args: Hex;
  isContract: boolean;
};

export function prepareLiftBid(bid: LimitOrder, poolId: Hex): PreparedLiftBid {
  const missing: string[] = [];
  if (!bid.signature) missing.push("signature");
  if (!bid.extension) missing.push("extension");
  if (!bid.makerAccountType) missing.push("makerAccountType");
  if (!bid.remainingTakingAmount) missing.push("remainingTakingAmount");
  if (missing.length > 0) {
    throw new Error(`Bid is missing required fields: ${missing.join(", ")}`);
  }

  const order = orderFromLimitOrder(bid);
  const orderArgs = orderToContractArgs(order);
  const { traits, args } = buildLiftTakerTraits(bid, CONTRACTS.ADAPTER, poolId);
  const amount = BigInt(bid.remainingTakingAmount);

  return {
    orderArgs,
    signature: bid.signature,
    amount,
    traits,
    args,
    isContract: bid.makerAccountType === "CONTRACT",
  };
}
