// Underwriter posts a JIT SELL: static price (like plain-order.mjs) but the
// cST is minted just in time inside each fill — no pre-deposit, no cleanup.
// The only deltas vs plain-order.mjs are marked with // [JIT].
//
// Prereqs (once): approve cST -> LOP (per market), approve CA -> ADAPTER
// (per CA token). Nothing minted upfront.
//
// env: PRIVATE_KEY, ORDERBOOK_URL, ADAPTER, POOL_ID, CST, CA, CA_DECIMALS,
//      SIZE_CST (18-dec), PRICE_CA_PER_CST, EXPIRY_SECONDS (default 3600)

import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import {
  buildExtension,
  buildMakerTraits,
  orderTypedData,
  packTargetAndData,
  saltForExtension,
} from "./lib.mjs";

const E = process.env;
const account = privateKeyToAccount(E.PRIVATE_KEY);

// ── Static amounts, exactly like plain-order.mjs.
const sizeCst = BigInt(E.SIZE_CST);
const caDecimals = BigInt(E.CA_DECIMALS);
const PRICE_SCALE = 1_000_000_000n;
const priceScaled = BigInt(Math.round(Number(E.PRICE_CA_PER_CST) * 1e9));
const premiumCa =
  (sizeCst * priceScaled * 10n ** caDecimals + (PRICE_SCALE * 10n ** 18n - 1n)) /
  (PRICE_SCALE * 10n ** 18n);

// ── [JIT] The extension: ONLY the pre-interaction slot is used. No amount
//    getters — the price stays the static ratio above.
const extension = buildExtension({
  preInteractionData: packTargetAndData(E.ADAPTER, E.POOL_ID),
});

// ── [JIT] Traits gain two flags; everything else is identical to plain.
const expiry = Math.floor(Date.now() / 1000) + Number(E.EXPIRY_SECONDS ?? 3600);
const nonce = BigInt(Math.floor(Date.now() / 1000)) & ((1n << 40n) - 1n);
const makerTraits = buildMakerTraits({
  expiry,
  nonce,
  allowPartialFills: true,
  allowMultipleFills: true,
  hasExtension: true, // [JIT]
  preInteraction: true, // [JIT]
});

const order = {
  salt: saltForExtension(extension), // [JIT] salt commits to the extension
  maker: account.address,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: E.CST,
  takerAsset: E.CA,
  makingAmount: sizeCst,
  takingAmount: premiumCa,
  makerTraits,
};

const typed = orderTypedData(arbitrum.id, order);
const signature = await account.signTypedData(typed);
const orderHash = hashTypedData(typed);

const res = await fetch(`${E.ORDERBOOK_URL}/v1/limit-orders`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
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
    makerAccountType: "EOA",
    makerPermit2: "",
    extension, // [JIT] the book stores + serves these bytes; takers need them
    side: "SELL",
    premium: Number(E.PREMIUM_DISPLAY ?? 0),
    expiry,
    nonce: nonce.toString(),
    allowsPartialFills: true,
    chainId: arbitrum.id,
  }),
});
console.log(res.status, await res.json());
