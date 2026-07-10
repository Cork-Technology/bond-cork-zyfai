// Fill a JIT order. Identical to plain-fill.mjs except the ONE thing an
// extension changes for takers: pass the order's exact extension bytes in
// the fill args and use fillOrderArgs. Price math is unchanged (static).
//
// Taker prereq: approve CA -> LOP (you pay the premium; the cST you receive
// is minted by the maker's hook inside the same transaction).
//
// env: PRIVATE_KEY, RPC_URL, ORDERBOOK_URL, POOL_ID, AMOUNT (making units)

import { createWalletClient, http, publicActions, hexToBigInt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { FILL_ORDER_ARGS_ABI, LOP_ADDRESS, buildTakerTraits, toCompactSignature } from "./lib.mjs";

const E = process.env;
const account = privateKeyToAccount(E.PRIVATE_KEY);
const client = createWalletClient({ account, chain: arbitrum, transport: http(E.RPC_URL) }).extend(publicActions);

// 1. Pick a JIT ask (has extension bytes) off the book.
const qs = new URLSearchParams({ chainId: String(arbitrum.id), poolId: E.POOL_ID, side: "SELL" });
qs.append("status", "OPEN");
qs.append("status", "PARTIALLY_FILLED");
const page = await fetch(`${E.ORDERBOOK_URL}/v1/limit-orders/orderbook?${qs}`).then((r) => r.json());
const order = page.items.find((o) => o.extension && o.extension !== "0x" && o.extension !== "");
if (!order) throw new Error("no extension-carrying asks resting on this market");

// 2. Static price, same check as plain-fill.
console.log("filling", order.orderHash, "price:", Number(order.takingAmount) / Number(order.makingAmount));

// 3. Fill with the extension bytes in args — the only taker-side delta.
const amount = BigInt(E.AMOUNT ?? order.remainingMakingAmount);
const threshold =
  (BigInt(order.takingAmount) * amount + BigInt(order.makingAmount) - 1n) / BigInt(order.makingAmount);
const { traits, args } = buildTakerTraits({
  makerAmount: true,
  threshold,
  extensionHex: order.extension, // [JIT] must be byte-exact or InvalidExtension
});

const { r, vs } = toCompactSignature(order.signature);
const hash = await client.writeContract({
  address: LOP_ADDRESS,
  abi: FILL_ORDER_ARGS_ABI,
  functionName: "fillOrderArgs",
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
    r,
    vs,
    amount,
    traits,
    args,
  ],
});
console.log("fill tx:", hash);
