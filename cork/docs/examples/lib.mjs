// Shared helpers for building, signing and filling Cork coverage orders on
// 1inch LOP v4 (verified against limit-order-protocol master: ExtensionLib,
// MakerTraitsLib, TakerTraitsLib, OrderLib).
//
// Everything here is deterministic byte-plumbing; the economics live in
// CorkLimitOrderAdapter on-chain.

import {
  concatHex,
  keccak256,
  toHex,
  pad,
  slice,
  hexToBigInt,
} from "viem";

// ── 1inch canonical deployment (identical address on Arbitrum One) ───────────
export const LOP_ADDRESS = "0x111111125421cA6dc452d289314280a0f8842A65";

// ── Extension encoding ────────────────────────────────────────────────────────
// Layout (ExtensionLib): 32-byte header = 8 packed uint32 CUMULATIVE END
// offsets (field 0's end in the LOWEST 32 bits), followed by the concatenated
// field bytes in enum order:
//   0 MakerAssetSuffix, 1 TakerAssetSuffix, 2 MakingAmountData,
//   3 TakingAmountData, 4 Predicate, 5 MakerPermit, 6 PreInteractionData,
//   7 PostInteractionData (CustomData tails after, unused here).
// Each *Data field = 20-byte target address ++ extraData.

export function packTargetAndData(target, extraDataHex) {
  return concatHex([target, extraDataHex ?? "0x"]);
}

export function buildExtension({
  makingAmountData = "0x", // getter extraData; unused for JIT-only orders
  takingAmountData = "0x", // getter extraData; unused for JIT-only orders
  preInteractionData = "0x", // packTargetAndData(hook, abi.encode(poolId))
  postInteractionData = "0x",
} = {}) {
  const fields = [
    "0x", // MakerAssetSuffix
    "0x", // TakerAssetSuffix
    makingAmountData,
    takingAmountData,
    "0x", // Predicate
    "0x", // MakerPermit
    preInteractionData,
    postInteractionData,
  ];
  const byteLen = (hex) => (hex.length - 2) / 2;
  if (fields.every((f) => byteLen(f) === 0)) return "0x";

  let offsets = 0n;
  let cumulative = 0n;
  fields.forEach((field, i) => {
    cumulative += BigInt(byteLen(field));
    offsets |= cumulative << (32n * BigInt(i));
  });
  return concatHex([pad(toHex(offsets), { size: 32 }), ...fields]);
}

// The LOP commits to the extension via the salt: low 160 bits of salt MUST
// equal low 160 bits of keccak256(extension) (OrderLib.isValidExtension),
// or every fill reverts InvalidExtension. Upper 96 bits are free entropy.
export function saltForExtension(extensionHex, entropy = BigInt(Date.now())) {
  const MASK160 = (1n << 160n) - 1n;
  const commitment = hexToBigInt(keccak256(extensionHex)) & MASK160;
  return ((entropy & ((1n << 96n) - 1n)) << 160n) | commitment;
}

// ── MakerTraits (bit layout verified against MakerTraitsLib) ─────────────────
export function buildMakerTraits({
  expiry = 0, // unix seconds; 0 = no order expiry (market expiry still applies via the getter)
  nonce = 0n,
  allowPartialFills = true,
  allowMultipleFills = true,
  hasExtension = false, // MUST be true when the order carries an extension
  preInteraction = false, // MUST be true for JIT-mint asks
  usePermit2 = false,
} = {}) {
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

// ── Order expiry (lives INSIDE the makerTraits bitfield, bits 80-119) ────────
// LOP v4 carries the expiration timestamp in the maker traits: fills revert
// OrderExpired once block.timestamp > expiry; 0 = never expires. There is no
// off-chain cancel — a superseded order stays fillable until it expires — so
// EVERY negotiation order (bid, ask, counter) must set one.
export function orderExpiry(lifetimeSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  return nowSeconds + Number(lifetimeSeconds);
}

// Decode the expiry back out of a makerTraits value (returns unix seconds; 0 = none).
export function expiryOf(makerTraits) {
  return Number((BigInt(makerTraits) >> 80n) & ((1n << 40n) - 1n));
}

// ── TakerTraits (bit layout verified against TakerTraitsLib) ─────────────────
// threshold: max taking amount you agree to pay (protects against price
// movement between quote and inclusion). extension/interaction lengths tell
// the LOP how to split the `args` bytes.
export function buildTakerTraits({
  makerAmount = true, // true: `amount` param is a MAKING amount (recommended: exact cST size)
  threshold = 0n,
  extensionHex = "0x",
  interactionHex = "0x",
  target = null, // optional receiver of maker funds (defaults to msg.sender)
} = {}) {
  let traits = threshold & ((1n << 185n) - 1n);
  if (makerAmount) traits |= 1n << 255n;
  const extLen = BigInt((extensionHex.length - 2) / 2);
  const intLen = BigInt((interactionHex.length - 2) / 2);
  traits |= extLen << 224n;
  traits |= intLen << 200n;
  let args = "0x";
  if (target) {
    traits |= 1n << 251n;
    args = concatHex([target, extensionHex, interactionHex]);
  } else {
    args = concatHex([extensionHex, interactionHex]);
  }
  return { traits, args };
}

// ── EIP-712 order signing ────────────────────────────────────────────────────
export function orderTypedData(chainId, order) {
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
    primaryType: "Order",
    message: order,
  };
}

// fillOrderArgs takes the signature as EIP-2098 compact (r, vs).
export function toCompactSignature(signature65) {
  const r = slice(signature65, 0, 32);
  const s = hexToBigInt(slice(signature65, 32, 64));
  const v = hexToBigInt(slice(signature65, 64, 65));
  const vs = toHex((v - 27n) << 255n | s, { size: 32 });
  return { r, vs };
}

// CONTRACT makers (e.g. a Safe) are filled with the contract variant: the
// signature travels as RAW BYTES and the maker contract validates it via
// ERC-1271 (isValidSignature). Branch on the book's `makerAccountType`:
// "EOA" -> fillOrderArgs (compact r/vs), "CONTRACT" -> fillContractOrderArgs.
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
];

// ── Known custom errors (LOP v4 + CorkLimitOrderAdapter) ────────────────────
// Concat these into the ABI you pass viem so a failed fill throws with the
// DECODED error name (e.g. `InvalidExtensionHash`) instead of raw bytes.
export const KNOWN_ERRORS_ABI = [
  // 1inch LOP v4 (OrderMixin / OrderLib / RouterErrors)
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
  // CorkLimitOrderAdapter
  { type: "error", name: "OnlyLimitOrderProtocol", inputs: [] },
  { type: "error", name: "OrderNotForPool", inputs: [] },
  { type: "error", name: "MintUnavailable", inputs: [] },
  { type: "error", name: "MintAmountDrift", inputs: [] },
];

// Fail loudly: print the deepest decoded revert (name + args when the error is
// in the ABI, raw short message otherwise) and exit non-zero.
export function failWith(step, error) {
  const revert = error?.walk?.((e) => e?.name === "ContractFunctionRevertedError") ?? null;
  const detail = revert?.data
    ? `${revert.data.errorName}(${(revert.data.args ?? []).join(", ")})`
    : (revert?.signature ?? error?.shortMessage ?? String(error));
  console.error(`FAILED at ${step}: ${detail}`);
  process.exit(1);
}

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
];
