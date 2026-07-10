// Bond (underwriter) lifts a BID directly, acting as taker: receives the
// premium in CA, delivers cST minted JUST IN TIME inside the same tx via
// CorkLimitOrderAdapter's takerInteraction (chosen here at fill time — the bidder
// never signed anything about it).
//
// Setup (same approvals as the maker path): cST -> LOP, CA -> hook.
//
// env: PRIVATE_KEY, RPC_URL, ORDERBOOK_URL, POOL_ID, ADAPTER, MIN_RATE_BPS (floor)

import { createWalletClient, http, publicActions, hexToBigInt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import {
  FILL_ORDER_ARGS_ABI,
  LOP_ADDRESS,
  buildTakerTraits,
  packTargetAndData,
  toCompactSignature,
} from "./lib.mjs";

const E = process.env;
const account = privateKeyToAccount(E.PRIVATE_KEY);
const client = createWalletClient({ account, chain: arbitrum, transport: http(E.RPC_URL) }).extend(publicActions);

// 1. Read the bids on our market.
const qs = new URLSearchParams({ chainId: String(arbitrum.id), poolId: E.POOL_ID, side: "BUY" });
qs.append("status", "OPEN");
qs.append("status", "PARTIALLY_FILLED");
const page = await fetch(`${E.ORDERBOOK_URL}/v1/limit-orders/orderbook?${qs}`).then((r) => r.json());
if (!page.items.length) throw new Error("no bids resting on this market");
const bid = page.items[0];

// Underwrite check: bid.premium is the annualized rate — fill only at/above
// our floor.
if (bid.premium * 100 < Number(E.MIN_RATE_BPS)) throw new Error("bid below floor");

// 2. Fill as taker. For a BID, makerAsset = CA premium,
//    takerAsset = cST (what WE deliver). amount = TAKING amount (makerAmount:
//    false) = exact cST size; the premium we receive is pro-rata to the signed price.
//    The interaction = our JIT hook + poolId: it fires AFTER the premium lands
//    on us and BEFORE the LOP pulls the cST — minting exactly what we owe.
const sizeCst = BigInt(bid.remainingTakingAmount); // lift the whole bid (or less)

const { traits, args } = buildTakerTraits({
  makerAmount: false,
  threshold: 0n, // taker gives cST; premium received is pro-rata (floor-checked above)
  extensionHex: bid.extension, // the bid's own extension (its JIT pre-interaction, if any)
  interactionHex: packTargetAndData(E.ADAPTER, E.POOL_ID), // OUR choice, unsigned
});

const { r, vs } = toCompactSignature(bid.signature);
const hash = await client.writeContract({
  address: LOP_ADDRESS,
  abi: FILL_ORDER_ARGS_ABI,
  functionName: "fillOrderArgs",
  args: [
    {
      salt: BigInt(bid.salt),
      maker: hexToBigInt(bid.maker),
      receiver: hexToBigInt(bid.receiver),
      makerAsset: hexToBigInt(bid.makerAsset),
      takerAsset: hexToBigInt(bid.takerAsset),
      makingAmount: BigInt(bid.makingAmount),
      takingAmount: BigInt(bid.takingAmount),
      makerTraits: BigInt(bid.makerTraits),
    },
    r,
    vs,
    sizeCst,
    traits,
    args,
  ],
});
console.log("lift tx:", hash);
