// A CONTRACT maker (minimal ERC-1271 wallet standing in for a Safe) posts a
// SELL ask. Same order bytes as an EOA — the deltas are WHO the maker is and
// HOW the signature is made (see contract-maker.md). Variant switch, matching
// plain-order.mjs's SIDE style:
//   VARIANT=PLAIN  wallet pre-mints the cST it sells (capital locked while resting)
//   VARIANT=JIT    nothing minted upfront; the signed extension mints at fill
//
// The script deploys the wallet from the Foundry artifact (run `forge build`
// first), funds it with CA from the owner EOA, and issues the approvals
// through the wallet's `execute` passthrough.
//
// Handoff: POSTs to ORDERBOOK_URL when set (makerAccountType: "CONTRACT"),
// otherwise writes the payload to ORDER_FILE (default ./contract-order.json)
// so contract-fill.mjs can pick it up on a bare fork.
//
// env: PRIVATE_KEY (wallet owner EOA), RPC_URL, VARIANT (PLAIN|JIT),
//      POOL_MANAGER, POOL_ID, ADAPTER (JIT only), CST, CA, CA_DECIMALS,
//      SIZE_CST (18-dec), PRICE_CA_PER_CST, EXPIRY_SECONDS (default 3600),
//      ORDERBOOK_URL or ORDER_FILE, WALLET (optional: reuse a deployed wallet)

import { readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, encodeFunctionData, hashTypedData, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import {
  LOP_ADDRESS,
  buildExtension,
  buildMakerTraits,
  failWith,
  orderExpiry,
  orderTypedData,
  packTargetAndData,
  saltForExtension,
} from "./lib.mjs";

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];
const POOL_MANAGER_ABI = [
  { type: "function", name: "previewMint", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }, { name: "cptAndCstSharesOut", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "poolId", type: "bytes32" }, { name: "cptAndCstSharesOut", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ type: "uint256" }] },
];
const WALLET_EXECUTE_ABI = [
  { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }], outputs: [{ type: "bytes" }] },
];

const E = process.env;
const owner = privateKeyToAccount(E.PRIVATE_KEY);
const client = createWalletClient({ account: owner, chain: arbitrum, transport: http(E.RPC_URL) }).extend(publicActions);
const variant = E.VARIANT === "PLAIN" ? "PLAIN" : "JIT";

// Every state-changing call goes through here so a revert dies decoded.
async function send(step, request) {
  try {
    const hash = await client.writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${step}: tx reverted (${hash})`);
    return receipt;
  } catch (error) {
    failWith(step, error);
  }
}

// The wallet acts through its owner-gated passthrough — this is the stand-in
// for a Safe's execTransaction.
const viaWallet = (wallet, step, target, abi, functionName, args) =>
  send(step, {
    address: wallet,
    abi: WALLET_EXECUTE_ABI,
    functionName: "execute",
    args: [target, encodeFunctionData({ abi, functionName, args })],
  });

// ── 1. Deploy the wallet from the Foundry artifact (or reuse WALLET) ─────────
let wallet = E.WALLET;
if (!wallet) {
  const artifact = JSON.parse(readFileSync(new URL("../../out/ERC1271Wallet.sol/ERC1271Wallet.json", import.meta.url)));
  const deployHash = await client.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [owner.address],
  });
  wallet = (await client.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
}
console.log("wallet (CONTRACT maker):", wallet);

// ── 2. Amounts — static price, same math as plain-order.mjs ──────────────────
const sizeCst = BigInt(E.SIZE_CST);
const caDecimals = BigInt(E.CA_DECIMALS);
const PRICE_SCALE = 1_000_000_000n;
const priceScaled = BigInt(Math.round(Number(E.PRICE_CA_PER_CST) * 1e9));
const premiumCa =
  (sizeCst * priceScaled * 10n ** caDecimals + (PRICE_SCALE * 10n ** 18n - 1n)) /
  (PRICE_SCALE * 10n ** 18n);

// ── 3. Fund + approve, per variant. The wallet always needs the collateral;
//      the variant decides WHEN it turns into cST (now vs at fill).
const collateralIn = await client.readContract({
  address: E.POOL_MANAGER, abi: POOL_MANAGER_ABI, functionName: "previewMint", args: [E.POOL_ID, sizeCst],
});
if (collateralIn === 0n) failWith("previewMint", new Error("pool cannot mint (paused or expired)"));
await send("fund wallet with CA", {
  address: E.CA, abi: ERC20_ABI, functionName: "transfer", args: [wallet, collateralIn],
});
await viaWallet(wallet, "approve cST -> LOP", E.CST, ERC20_ABI, "approve", [LOP_ADDRESS, sizeCst]);
if (variant === "PLAIN") {
  // Pre-mint: the pre-deposit JIT eliminates, spelled out (see plain-order.md step 1).
  await viaWallet(wallet, "approve CA -> poolManager", E.CA, ERC20_ABI, "approve", [E.POOL_MANAGER, collateralIn]);
  await viaWallet(wallet, "pre-mint cST", E.POOL_MANAGER, POOL_MANAGER_ABI, "mint", [E.POOL_ID, sizeCst, wallet]);
} else {
  // JIT: the adapter pulls the CA from the MAKER (the wallet) inside the fill.
  await viaWallet(wallet, "approve CA -> adapter", E.CA, ERC20_ABI, "approve", [E.ADAPTER, collateralIn]);
}

// ── 4. The order. Identical shape to jit-order.mjs / plain-order.mjs — the
//      maker is the WALLET, not the signing EOA.
const extension = variant === "JIT" ? buildExtension({ preInteractionData: packTargetAndData(E.ADAPTER, E.POOL_ID) }) : "0x";
const expiry = orderExpiry(E.EXPIRY_SECONDS ?? 3600);
const nonce = BigInt(Math.floor(Date.now() / 1000)) & ((1n << 40n) - 1n);
const makerTraits = buildMakerTraits({
  expiry,
  nonce,
  allowPartialFills: true,
  allowMultipleFills: true,
  hasExtension: variant === "JIT",
  preInteraction: variant === "JIT",
});

const order = {
  salt: variant === "JIT" ? saltForExtension(extension) : BigInt(Date.now()),
  maker: wallet,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: E.CST,
  takerAsset: E.CA,
  makingAmount: sizeCst,
  takingAmount: premiumCa,
  makerTraits,
};

// ── 5. Sign. The EIP-712 order hash is UNCHANGED (domain = the LOP, maker =
//      the wallet). The owner EOA signs that hash RAW — 65 bytes of r ++ s ++ v
//      that the wallet's isValidSignature recovers. NOTE a real Safe differs
//      here: it wraps the hash in its own SafeMessage envelope first
//      (see contract-maker.md).
const typed = orderTypedData(arbitrum.id, order);
const orderHash = hashTypedData(typed);
const signature = await owner.sign({ hash: orderHash });

// ── 6. Hand off: the book when configured, a local file otherwise.
const payload = {
  salt: order.salt.toString(),
  maker: order.maker,
  receiver: order.receiver,
  makerAsset: order.makerAsset,
  takerAsset: order.takerAsset,
  makingAmount: sizeCst.toString(),
  takingAmount: premiumCa.toString(),
  makerTraits: makerTraits.toString(),
  orderHash,
  signature,
  makerAccountType: "CONTRACT", // the API verifies via ERC-1271, takers branch on this
  makerPermit2: "",
  extension: variant === "JIT" ? extension : "",
  side: "SELL",
  premium: Number(E.PREMIUM_DISPLAY ?? 0),
  expiry,
  nonce: nonce.toString(),
  allowsPartialFills: true,
  chainId: arbitrum.id,
};
if (E.ORDERBOOK_URL) {
  const res = await fetch(`${E.ORDERBOOK_URL}/v1/limit-orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(res.status, await res.json());
} else {
  const file = E.ORDER_FILE ?? "./contract-order.json";
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`no ORDERBOOK_URL — ${variant} order written to ${file}`, orderHash);
}
