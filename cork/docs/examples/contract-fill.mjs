// Fill a CONTRACT-maker order — the other branch of the makerAccountType
// rule: the signature travels as RAW BYTES and the entry point is
// fillContractOrderArgs (the maker contract validates via ERC-1271 instead
// of ECDSA recovery). Everything else — amounts, threshold, extension
// handling — is identical to plain-fill.mjs / jit-fill.mjs.
//
// Taker prereq: approve CA -> LOP (you pay the premium).
//
// Order source: the book when ORDERBOOK_URL is set, otherwise the handoff
// file written by contract-order.mjs.
//
// env: PRIVATE_KEY (taker EOA), RPC_URL, ORDERBOOK_URL + POOL_ID or
//      ORDER_FILE (default ./contract-order.json), AMOUNT (making units)

import { readFileSync } from "node:fs";
import { createWalletClient, hexToBigInt, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { FILL_CONTRACT_ORDER_ARGS_ABI, KNOWN_ERRORS_ABI, LOP_ADDRESS, buildTakerTraits, failWith } from "./lib.mjs";

const E = process.env;
const account = privateKeyToAccount(E.PRIVATE_KEY);
const client = createWalletClient({ account, chain: arbitrum, transport: http(E.RPC_URL) }).extend(publicActions);

// 1. Pick the order: off the book (filter on makerAccountType) or the file.
let order;
if (E.ORDERBOOK_URL) {
  const qs = new URLSearchParams({ chainId: String(arbitrum.id), poolId: E.POOL_ID, side: "SELL" });
  qs.append("status", "OPEN");
  qs.append("status", "PARTIALLY_FILLED");
  const page = await fetch(`${E.ORDERBOOK_URL}/v1/limit-orders/orderbook?${qs}`).then((r) => r.json());
  order = page.items.find((o) => o.makerAccountType === "CONTRACT");
  if (!order) throw new Error("no contract-maker asks resting on this market");
} else {
  order = JSON.parse(readFileSync(E.ORDER_FILE ?? "./contract-order.json"));
}
if (order.makerAccountType !== "CONTRACT") {
  throw new Error("order is EOA-made — use fillOrderArgs (plain-fill.mjs / jit-fill.mjs) instead");
}

// 2. Static price, same check as the other fills.
console.log("filling", order.orderHash, "price:", Number(order.takingAmount) / Number(order.makingAmount));

// 3. Fill. Two deltas vs the EOA path: raw `signature` bytes instead of the
//    compact r/vs split, and the ContractOrder entry point. The extension
//    bytes (if the ask is JIT) ride along exactly as in jit-fill.mjs.
const amount = BigInt(E.AMOUNT ?? order.remainingMakingAmount ?? order.makingAmount);
const threshold =
  (BigInt(order.takingAmount) * amount + BigInt(order.makingAmount) - 1n) / BigInt(order.makingAmount);
const { traits, args } = buildTakerTraits({
  makerAmount: true,
  threshold,
  extensionHex: order.extension && order.extension !== "" ? order.extension : "0x",
});

try {
  const hash = await client.writeContract({
    address: LOP_ADDRESS,
    abi: [...FILL_CONTRACT_ORDER_ARGS_ABI, ...KNOWN_ERRORS_ABI],
    functionName: "fillContractOrderArgs",
    args: [
      {
        salt: BigInt(order.salt),
        maker: hexToBigInt(order.maker),
        receiver: hexToBigInt(order.receiver),
        makerAsset: hexToBigInt(order.makerAsset),
        takerAsset: hexToBigInt(order.takerAsset),
        makingAmount: BigInt(order.makingAmount),
        takingAmount: BigInt(order.takingAmount),
        makerTraits: BigInt(order.makerTraits),
      },
      order.signature,
      amount,
      traits,
      args,
    ],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`fill reverted (${hash})`);
  console.log("fill tx:", hash);
} catch (error) {
  failWith("fillContractOrderArgs", error);
}
