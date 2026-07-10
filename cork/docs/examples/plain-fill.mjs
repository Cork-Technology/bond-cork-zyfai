// Fill a PLAIN order from the Cork orderbook with the LOP's simplest entry
// point: fillOrder(order, r, vs, amount, takerTraits) — no args bytes needed
// because plain orders carry no extension.
//
// Taker prerequisites: approve the taker-side asset to the LOP (CA when
// lifting a SELL; cST — which you must hold — when lifting a BUY).
//
// env: PRIVATE_KEY, RPC_URL, ORDERBOOK_URL, POOL_ID, TAKE_SIDE (SELL = lift
//      an ask / BUY = hit a bid), AMOUNT (making-amount units of the order;
//      <= remainingMakingAmount, partial fills welcome)

import { createWalletClient, http, publicActions, hexToBigInt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { LOP_ADDRESS, buildTakerTraits, toCompactSignature } from "./lib.mjs";

const FILL_ORDER_ABI = [
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
    ],
    name: "fillOrder",
    outputs: [
      { name: "makingAmount", type: "uint256" },
      { name: "takingAmount", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
    stateMutability: "payable",
    type: "function",
  },
];

const E = process.env;
const account = privateKeyToAccount(E.PRIVATE_KEY);
const client = createWalletClient({ account, chain: arbitrum, transport: http(E.RPC_URL) }).extend(publicActions);

// 1. Pick an order off the book (best = your own policy; first here).
const qs = new URLSearchParams({
  chainId: String(arbitrum.id),
  poolId: E.POOL_ID,
  side: E.TAKE_SIDE === "BUY" ? "BUY" : "SELL",
});
qs.append("status", "OPEN");
qs.append("status", "PARTIALLY_FILLED");
const page = await fetch(`${E.ORDERBOOK_URL}/v1/limit-orders/orderbook?${qs}`).then((r) => r.json());
const order = page.items.find((o) => o.extension === "" || o.extension === "0x");
if (!order) throw new Error("no plain orders resting on this market/side");

// 2. Static price check — the numbers ARE the price, no recomputation needed:
//    price (CA per cST) = SELL: takingAmount/makingAmount, BUY: making/taking.
console.log("filling", order.orderHash, "price:", order.side === "SELL"
  ? Number(order.takingAmount) / Number(order.makingAmount)
  : Number(order.makingAmount) / Number(order.takingAmount));

// 3. Fill. amount is in MAKING-amount units; threshold caps what you pay
//    (static here, so exact pro-rata is fine).
const amount = BigInt(E.AMOUNT ?? order.remainingMakingAmount);
const threshold =
  (BigInt(order.takingAmount) * amount + BigInt(order.makingAmount) - 1n) / BigInt(order.makingAmount);
const { traits } = buildTakerTraits({ makerAmount: true, threshold });

const { r, vs } = toCompactSignature(order.signature);
const hash = await client.writeContract({
  address: LOP_ADDRESS,
  abi: FILL_ORDER_ABI,
  functionName: "fillOrder",
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
  ],
});
console.log("fill tx:", hash);
