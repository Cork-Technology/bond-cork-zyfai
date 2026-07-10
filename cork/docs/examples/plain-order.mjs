// Build, sign and post a PLAIN 1inch LOP v4 order — no extension,
// no JIT. Works for both roles:
//   SIDE=SELL  underwriter sells cST for CA premium (must already HOLD the cST)
//   SIDE=BUY   hedger offers CA premium for cST (must hold the CA)
//
// See plain-order.md for the full ceremony (URLs, prerequisites, fill, cancel).
//
// env: SIDE, PRIVATE_KEY, ORDERBOOK_URL, CST, CA, CA_DECIMALS,
//      SIZE_CST (18-dec cST size), PRICE_CA_PER_CST (decimal, CA per 1 cST),
//      EXPIRY_SECONDS (order lifetime, default 3600)

import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { buildMakerTraits, orderTypedData } from "./lib.mjs";

const E = process.env;
const account = privateKeyToAccount(E.PRIVATE_KEY);
const side = E.SIDE === "BUY" ? "BUY" : "SELL";

// ── Amounts. Price is static: takingAmount/makingAmount IS the price forever.
const sizeCst = BigInt(E.SIZE_CST); // 18-dec cST shares
const caDecimals = BigInt(E.CA_DECIMALS);
// premium (CA native) = sizeCst x price, ceil — scale price by 1e9 to keep
// integer math exact for prices like 0.0000603.
const PRICE_SCALE = 1_000_000_000n;
const priceScaled = BigInt(Math.round(Number(E.PRICE_CA_PER_CST) * 1e9));
const premiumCa =
  (sizeCst * priceScaled * 10n ** caDecimals + (PRICE_SCALE * 10n ** 18n - 1n)) /
  (PRICE_SCALE * 10n ** 18n);

const [makerAsset, takerAsset, makingAmount, takingAmount] =
  side === "SELL"
    ? [E.CST, E.CA, sizeCst, premiumCa] // sell cST, receive CA
    : [E.CA, E.CST, premiumCa, sizeCst]; // pay CA, receive cST

// ── Traits: expiry + nonce + partial/multiple fills. NOTHING else — no
//    extension flag, no interaction flags. That is the whole point.
const expiry = Math.floor(Date.now() / 1000) + Number(E.EXPIRY_SECONDS ?? 3600);
const nonce = BigInt(Math.floor(Date.now() / 1000)) & ((1n << 40n) - 1n);
const makerTraits = buildMakerTraits({
  expiry,
  nonce,
  allowPartialFills: true,
  allowMultipleFills: true,
});

// ── The order. salt is unconstrained without an extension — unique is enough.
const order = {
  salt: BigInt(Date.now()),
  maker: account.address,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset,
  takerAsset,
  makingAmount,
  takingAmount,
  makerTraits,
};

// ── Sign (EIP-712, canonical LOP as verifying contract) and post.
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
    makerAsset,
    takerAsset,
    makingAmount: makingAmount.toString(),
    takingAmount: takingAmount.toString(),
    makerTraits: makerTraits.toString(),
    orderHash,
    signature,
    makerAccountType: "EOA",
    makerPermit2: "",
    extension: "", // plain order — this field only carries bytes for adapter orders
    side,
    premium: Number(E.PREMIUM_DISPLAY ?? 0), // display metadata (percent), not enforced
    expiry,
    nonce: nonce.toString(),
    allowsPartialFills: true,
    chainId: arbitrum.id,
  }),
});
console.log(res.status, await res.json());
