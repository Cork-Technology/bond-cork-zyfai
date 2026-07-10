// Ceremony step 1+2 as one runnable script: CREATE THE MARKET — the on-chain
// act that IS the request for quote — then post the opening BUY bid on the
// fresh pool. The bid is capital-free JIT from the counterparty's point of
// view: an underwriter lifts it with the taker-side interaction
// (lift-bid.mjs), minting its cST delivery inside the fill.
//
// createMarket goes through CorkMarketCreator (which deploys the fixed-rate
// oracle via the factory — one deploy per rate, a reused rate reverts).
// isWhitelistEnabled is hardcoded false: NON-NEGOTIABLE, or every JIT mint
// on this market reverts later.
//
// Handoff: POSTs the bid to ORDERBOOK_URL when set, otherwise writes it to
// ORDER_FILE (default ./market-rfq-bid.json) so the flow runs on a bare fork.
//
// env: PRIVATE_KEY (asker EOA), RPC_URL, MARKET_CREATOR, CA, REF,
//      CA_DECIMALS, RATE (decimal, 1 REF quoted in CA, e.g. 0.8),
//      MARKET_LIFETIME_SECONDS (default 86400), SIZE_CST (18-dec),
//      PRICE_CA_PER_CST, EXPIRY_SECONDS (bid lifetime, default 3600),
//      SWAP_FEE_PCT / UNWIND_FEE_PCT (default 1 / 2),
//      ORDERBOOK_URL or ORDER_FILE

import { writeFileSync } from "node:fs";
import { createWalletClient, hashTypedData, http, parseEventLogs, parseUnits, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { buildMakerTraits, failWith, orderExpiry, orderTypedData } from "./lib.mjs";

const CREATOR_ABI = [
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "collateralAsset", type: "address" },
          { name: "referenceAsset", type: "address" },
          { name: "expiryTimestamp", type: "uint256" },
          { name: "rate", type: "uint256" },
          { name: "rateMin", type: "uint256" },
          { name: "rateMax", type: "uint256" },
          { name: "rateChangePerDayMax", type: "uint256" },
          { name: "rateChangeCapacityMax", type: "uint256" },
          { name: "swapFeePercentage", type: "uint256" },
          { name: "unwindSwapFeePercentage", type: "uint256" },
          { name: "isWhitelistEnabled", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },
  { type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "event",
    name: "MarketCreated",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "oracle", type: "address", indexed: false },
      { name: "collateralAsset", type: "address", indexed: false },
      { name: "referenceAsset", type: "address", indexed: false },
      { name: "expiryTimestamp", type: "uint256", indexed: false },
      { name: "rate", type: "uint256", indexed: false },
    ],
  },
];
const POOL_MANAGER_ABI = [
  {
    type: "function",
    name: "shares",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "principalToken", type: "address" }, { name: "swapToken", type: "address" }],
  },
];

const E = process.env;
const account = privateKeyToAccount(E.PRIVATE_KEY);
const client = createWalletClient({ account, chain: arbitrum, transport: http(E.RPC_URL) }).extend(publicActions);

// ── 1. Create the market. The confirmed fixed-rate recipe: rateMin = rate,
//      rateMax = rate + 1 (smallest value passing the strict min < max check),
//      both rate-change clamps zero (freezes drift).
const rate = parseUnits(E.RATE, 18);
const nowSeconds = Number((await client.getBlock()).timestamp);
const marketExpiry = nowSeconds + Number(E.MARKET_LIFETIME_SECONDS ?? 86400);
let receipt;
try {
  const hash = await client.writeContract({
    address: E.MARKET_CREATOR,
    abi: CREATOR_ABI,
    functionName: "createMarket",
    args: [
      {
        collateralAsset: E.CA,
        referenceAsset: E.REF,
        expiryTimestamp: BigInt(marketExpiry),
        rate,
        rateMin: rate,
        rateMax: rate + 1n,
        rateChangePerDayMax: 0n,
        rateChangeCapacityMax: 0n,
        swapFeePercentage: parseUnits(E.SWAP_FEE_PCT ?? "1", 18), // 1e18 = 1%
        unwindSwapFeePercentage: parseUnits(E.UNWIND_FEE_PCT ?? "2", 18),
        isWhitelistEnabled: false, // non-negotiable for JIT (mint's msg.sender is the adapter)
      },
    ],
  });
  receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`createMarket reverted (${hash})`);
} catch (error) {
  failWith("createMarket", error);
}

// The MarketCreated event carries the poolId; the pool manager maps it to the
// share tokens (cST is what the coverage orders trade).
const [created] = parseEventLogs({ abi: CREATOR_ABI, eventName: "MarketCreated", logs: receipt.logs });
const poolId = created.args.id;
const poolManager = await client.readContract({ address: E.MARKET_CREATOR, abi: CREATOR_ABI, functionName: "poolManager" });
const [, cst] = await client.readContract({ address: poolManager, abi: POOL_MANAGER_ABI, functionName: "shares", args: [poolId] });
console.log("market created — poolId:", poolId, "oracle:", created.args.oracle, "cST:", cst);

// ── 2. The opening bid: makerAsset = CA (the premium offered), takerAsset =
//      cST (the size wanted). Deliberately PLAIN-shaped — no extension: the
//      taker-side JIT interaction is the underwriter's own unsigned choice at
//      lift time. Expiry is mandatory (negotiation orders are superseded by
//      NEW orders, never cancelled — see ceremony.md, Counter-offers).
const sizeCst = BigInt(E.SIZE_CST);
const caDecimals = BigInt(E.CA_DECIMALS);
const PRICE_SCALE = 1_000_000_000n;
const priceScaled = BigInt(Math.round(Number(E.PRICE_CA_PER_CST) * 1e9));
const premiumCa =
  (sizeCst * priceScaled * 10n ** caDecimals + (PRICE_SCALE * 10n ** 18n - 1n)) /
  (PRICE_SCALE * 10n ** 18n);

const expiry = orderExpiry(E.EXPIRY_SECONDS ?? 3600, nowSeconds);
const nonce = BigInt(Math.floor(Date.now() / 1000)) & ((1n << 40n) - 1n);
const makerTraits = buildMakerTraits({ expiry, nonce, allowPartialFills: true, allowMultipleFills: true });

const order = {
  salt: BigInt(Date.now()),
  maker: account.address,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: E.CA,
  takerAsset: cst,
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
  poolId, // convenience for file-mode consumers; the API derives it from the assets
};
if (E.ORDERBOOK_URL) {
  // The indexer tails the chain — the pool appears on /v1/pools within
  // seconds. Retry on "no matching pool found", never re-create.
  const res = await fetch(`${E.ORDERBOOK_URL}/v1/limit-orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(res.status, await res.json());
} else {
  const file = E.ORDER_FILE ?? "./market-rfq-bid.json";
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`no ORDERBOOK_URL — opening bid written to ${file}`, orderHash);
}
