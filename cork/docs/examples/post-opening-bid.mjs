// Post (or re-post) the opening BUY bid for an already-created Cork pool.
// Use this when market-rfq.mjs created the market but the API indexer had
// not yet seen the pool ("no matching pool found"). It retries with backoff.
//
// env: PRIVATE_KEY, RPC_URL, ORDERBOOK_URL, CA, CA_DECIMALS, CST, POOL_ID,
//      SIZE_CST (18-dec), PRICE_CA_PER_CST, EXPIRY_SECONDS (default 3600)

import { createWalletClient, hashTypedData, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { buildMakerTraits, orderExpiry, orderTypedData } from "./lib.mjs";

const E = process.env;
const account = privateKeyToAccount(E.PRIVATE_KEY);

const sizeCst = BigInt(E.SIZE_CST);
const caDecimals = BigInt(E.CA_DECIMALS);
const PRICE_SCALE = 1_000_000_000n;
const priceScaled = BigInt(Math.round(Number(E.PRICE_CA_PER_CST) * 1e9));
const premiumCa =
  (sizeCst * priceScaled * 10n ** caDecimals + (PRICE_SCALE * 10n ** 18n - 1n)) /
  (PRICE_SCALE * 10n ** 18n);

const nowSeconds = Math.floor(Date.now() / 1000);
const expiry = orderExpiry(E.EXPIRY_SECONDS ?? 3600, nowSeconds);
const nonce = BigInt(nowSeconds) & ((1n << 40n) - 1n);
const makerTraits = buildMakerTraits({ expiry, nonce, allowPartialFills: true, allowMultipleFills: true });

const order = {
  salt: BigInt(Date.now()),
  maker: account.address,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: E.CA,
  takerAsset: E.CST,
  makingAmount: premiumCa,
  takingAmount: sizeCst,
  makerTraits,
};

const typed = orderTypedData(arbitrum.id, order);
const signature = await account.signTypedData(typed);
const orderHash = hashTypedData(typed);

const payload = {
  salt: order.salt.toString(),
  maker: order.maker,
  receiver: order.receiver,
  makerAsset: order.makerAsset,
  takerAsset: order.takerAsset,
  makingAmount: premiumCa.toString(),
  takingAmount: sizeCst.toString(),
  makerTraits: makerTraits.toString(),
  orderHash,
  signature,
  makerAccountType: "EOA",
  makerPermit2: "",
  extension: "",
  side: "BUY",
  premium: Number(E.PREMIUM_DISPLAY ?? 0),
  expiry,
  nonce: nonce.toString(),
  allowsPartialFills: true,
  chainId: arbitrum.id,
  poolId: E.POOL_ID,
};

async function postWithRetry(maxAttempts = 12, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${E.ORDERBOOK_URL}/v1/limit-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (res.ok) {
      console.log("bid posted:", body);
      return;
    }
    console.log(`attempt ${attempt}/${maxAttempts} failed:`, res.status, body.message ?? body.error ?? body);
    if (attempt < maxAttempts) {
      console.log(`waiting ${delayMs}ms before retry...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("failed to post bid after retries");
}

await postWithRetry();
