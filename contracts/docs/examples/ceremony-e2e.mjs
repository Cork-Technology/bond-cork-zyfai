// THE CEREMONY, END TO END, ONE SCRIPT: create market (the request for
// quote) → opening bid → discovery → counter-ask → fill. Two parties:
//   ASKER        wants cover: creates the market, bids, ultimately pays the
//                premium and receives cST.
//   UNDERWRITER  sells cover: discovers, counters with a JIT ask, keeps the
//                cPT leg and the premium.
//
// Both sides are account-type parameterized (the makerAccountType rule,
// exercised end to end): EOA signs EIP-712 + is filled via fillOrderArgs
// (compact r/vs); CONTRACT (a minimal ERC-1271 wallet standing in for a
// Safe — deployed here from the Foundry artifact, run `forge build` first)
// signs the raw order hash with its owner key + is filled via
// fillContractOrderArgs (raw bytes).
//
// Discovery is parameterized:
//   CORK_API_URL set        orders flow through POST/GET on the Cork API;
//                           the API being set but UNREACHABLE is a hard
//                           error — never a silent fallback.
//   CORK_API_URL unset      order payloads pass between steps through a
//                           local JSON file (STATE_FILE) — bare-fork mode.
//
// Negotiation rule on display: the counter is a NEW order, nothing is
// cancelled. The superseded opening bid stays fillable until its expiry —
// which is why every order below sets one.
//
// env: RPC_URL, ASKER_PK, UNDERWRITER_PK, ASKER_ACCOUNT (EOA|CONTRACT),
//      UNDERWRITER_ACCOUNT (EOA|CONTRACT), MARKET_CREATOR, ADAPTER, CA, REF,
//      CA_DECIMALS, RATE (decimal), SIZE_CST (18-dec),
//      BID_PRICE_CA_PER_CST (default 0.015),
//      UNDERWRITER_FLOOR_CA_PER_CST (default 0.02),
//      COUNTER_PRICE_CA_PER_CST (default = floor),
//      ASKER_CEILING_CA_PER_CST (default 0.025),
//      EXPIRY_SECONDS (order lifetime, default 3600),
//      MARKET_LIFETIME_SECONDS (default 86400),
//      CORK_API_URL or STATE_FILE (default ./ceremony-orders.json)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, encodeFunctionData, hashTypedData, hexToBigInt, http, parseEventLogs, parseUnits, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import {
  FILL_CONTRACT_ORDER_ARGS_ABI,
  FILL_ORDER_ARGS_ABI,
  KNOWN_ERRORS_ABI,
  LOP_ADDRESS,
  buildExtension,
  buildMakerTraits,
  buildTakerTraits,
  failWith,
  orderExpiry,
  orderTypedData,
  packTargetAndData,
  saltForExtension,
  toCompactSignature,
} from "./lib.mjs";

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "who", type: "address" }], outputs: [{ type: "uint256" }] },
];
const POOL_MANAGER_ABI = [
  { type: "function", name: "shares", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ name: "principalToken", type: "address" }, { name: "swapToken", type: "address" }] },
  { type: "function", name: "previewMint", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }, { name: "cptAndCstSharesOut", type: "uint256" }], outputs: [{ type: "uint256" }] },
];
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
const WALLET_EXECUTE_ABI = [
  { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }], outputs: [{ type: "bytes" }] },
];

const E = process.env;

// ── Parties: the account-type decision point, made concrete ──────────────────
// A party's ADDRESS is what goes in `maker` / receives assets; a CONTRACT
// party's owner EOA only signs and pays gas.
async function makeParty(role, pk, type) {
  const owner = privateKeyToAccount(pk);
  const client = createWalletClient({ account: owner, chain: arbitrum, transport: http(E.RPC_URL) }).extend(publicActions);
  const party = { role, type, owner, client, address: owner.address };
  if (type === "CONTRACT") {
    const artifact = JSON.parse(readFileSync(new URL("../../out/ERC1271Wallet.sol/ERC1271Wallet.json", import.meta.url)));
    const hash = await client.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address] });
    party.address = (await client.waitForTransactionReceipt({ hash })).contractAddress;
    console.log(`${role}: ERC-1271 wallet deployed at ${party.address} (owner ${owner.address})`);
  } else {
    console.log(`${role}: EOA ${party.address}`);
  }
  return party;
}

async function send(party, step, request) {
  try {
    const hash = await party.client.writeContract(request);
    const receipt = await party.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${step}: tx reverted (${hash})`);
    return receipt;
  } catch (error) {
    failWith(`${party.role} ${step}`, error);
  }
}

// State-changing calls AS the party: direct for an EOA, through the wallet's
// execute passthrough (the Safe execTransaction stand-in) for a CONTRACT.
async function act(party, step, { address, abi, functionName, args }) {
  if (party.type === "CONTRACT") {
    return send(party, step, {
      address: party.address,
      abi: WALLET_EXECUTE_ABI,
      functionName: "execute",
      args: [address, encodeFunctionData({ abi: [...abi, ...KNOWN_ERRORS_ABI], functionName, args })],
    });
  }
  return send(party, step, { address, abi: [...abi, ...KNOWN_ERRORS_ABI], functionName, args });
}

// The signature branch: an EOA signs the EIP-712 typed data; a CONTRACT
// maker's owner signs the raw order hash (a real Safe would wrap it in its
// SafeMessage envelope first — see contract-maker.md).
async function signOrder(party, order) {
  const typed = orderTypedData(arbitrum.id, order);
  const orderHash = hashTypedData(typed);
  const signature = party.type === "CONTRACT"
    ? await party.owner.sign({ hash: orderHash })
    : await party.owner.signTypedData(typed);
  return { orderHash, signature };
}

// ── Discovery: the Cork API when configured, a local JSON file otherwise ─────
const api = E.CORK_API_URL || null;
const stateFile = E.STATE_FILE ?? "./ceremony-orders.json";

async function apiRequest(path, init) {
  try {
    return await fetch(`${api}${path}`, init);
  } catch (error) {
    // Configured-but-unreachable is a HARD error: falling back to file mode
    // here would silently split the two agents onto different books.
    console.error(`FAILED: CORK_API_URL is set (${api}) but unreachable: ${error.cause?.code ?? error.message}`);
    process.exit(1);
  }
}

const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile)) : { orders: [] });

async function publishOrder(payload) {
  if (api) {
    const res = await apiRequest("/v1/limit-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (res.status !== 201) failWith("POST /v1/limit-orders", new Error(`${res.status} ${JSON.stringify(body)}`));
    return;
  }
  const state = readState();
  state.orders.push({ ...payload, status: "OPEN" });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function discoverOrders(poolId, side, chainNow) {
  if (api) {
    const qs = new URLSearchParams({ chainId: String(arbitrum.id), poolId, side });
    qs.append("status", "OPEN");
    qs.append("status", "PARTIALLY_FILLED");
    const res = await apiRequest(`/v1/limit-orders/orderbook?${qs}`);
    return (await res.json()).items;
  }
  return readState().orders.filter((o) => o.poolId === poolId && o.side === side && o.status === "OPEN" && o.expiry > chainNow);
}

// In API mode the indexer flips the status when it sees the on-chain fill; in
// file mode we book-keep ourselves.
function markFilled(orderHash) {
  if (api) return;
  const state = readState();
  const order = state.orders.find((o) => o.orderHash === orderHash);
  if (order) order.status = "FILLED";
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// In API mode the indexer needs a few seconds to register a fresh market;
// retry on miss, never re-create. File mode already knows the poolId.
async function waitForPool(poolId) {
  if (!api) return;
  for (let attempt = 0; attempt < 15; attempt++) {
    const res = await apiRequest(`/v1/pools?chainId=${arbitrum.id}`);
    const pools = (await res.json()).items ?? [];
    if (pools.some((p) => p.poolId === poolId)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  failWith("waitForPool", new Error(`pool ${poolId} not indexed after 30s`));
}

// ── Amount math (static prices, same ceil as the other examples) ─────────────
const sizeCst = BigInt(E.SIZE_CST);
const caDecimals = BigInt(E.CA_DECIMALS);
const PRICE_SCALE = 1_000_000_000n;
const premiumFor = (price) => {
  const priceScaled = BigInt(Math.round(Number(price) * 1e9));
  return (sizeCst * priceScaled * 10n ** caDecimals + (PRICE_SCALE * 10n ** 18n - 1n)) / (PRICE_SCALE * 10n ** 18n);
};
const bidPrice = Number(E.BID_PRICE_CA_PER_CST ?? 0.015);
const floorPrice = Number(E.UNDERWRITER_FLOOR_CA_PER_CST ?? 0.02);
const counterPrice = Number(E.COUNTER_PRICE_CA_PER_CST ?? floorPrice);
const ceilingPrice = Number(E.ASKER_CEILING_CA_PER_CST ?? 0.025);

const asker = await makeParty("asker", E.ASKER_PK, E.ASKER_ACCOUNT === "CONTRACT" ? "CONTRACT" : "EOA");
const underwriter = await makeParty("underwriter", E.UNDERWRITER_PK, E.UNDERWRITER_ACCOUNT === "CONTRACT" ? "CONTRACT" : "EOA");
const chainNow = async () => Number((await asker.client.getBlock()).timestamp);

// Shared payload shape (what the API expects; the file stores the same).
function orderPayload(party, order, { orderHash, signature }, side, extension, expiry, nonce, poolId) {
  return {
    salt: order.salt.toString(),
    maker: order.maker,
    receiver: order.receiver,
    makerAsset: order.makerAsset,
    takerAsset: order.takerAsset,
    makingAmount: order.makingAmount.toString(),
    takingAmount: order.takingAmount.toString(),
    makerTraits: order.makerTraits.toString(),
    orderHash,
    signature,
    makerAccountType: party.type,
    makerPermit2: "",
    extension,
    side,
    premium: 0,
    expiry,
    nonce: nonce.toString(),
    allowsPartialFills: true,
    chainId: arbitrum.id,
    poolId,
  };
}

// ═════ Step 1 — asker creates the market: the on-chain request for quote ═════
// (Sent from the owner EOA either way — creation is permissionless and carries
// no maker identity; only ORDERS need the account-type branch.)
const rate = parseUnits(E.RATE, 18);
const marketExpiry = (await chainNow()) + Number(E.MARKET_LIFETIME_SECONDS ?? 86400);
const createReceipt = await act(asker.type === "CONTRACT" ? { ...asker, type: "EOA" } : asker, "createMarket", {
  address: E.MARKET_CREATOR,
  abi: CREATOR_ABI,
  functionName: "createMarket",
  args: [
    {
      collateralAsset: E.CA,
      referenceAsset: E.REF,
      expiryTimestamp: BigInt(marketExpiry),
      rate,
      rateMin: rate, // fixed-rate recipe
      rateMax: rate + 1n,
      rateChangePerDayMax: 0n,
      rateChangeCapacityMax: 0n,
      swapFeePercentage: parseUnits("1", 18),
      unwindSwapFeePercentage: parseUnits("2", 18),
      isWhitelistEnabled: false, // non-negotiable for JIT
    },
  ],
});
const [created] = parseEventLogs({ abi: CREATOR_ABI, eventName: "MarketCreated", logs: createReceipt.logs });
const poolId = created.args.id;
const poolManager = await asker.client.readContract({ address: E.MARKET_CREATOR, abi: CREATOR_ABI, functionName: "poolManager" });
const [, cst] = await asker.client.readContract({ address: poolManager, abi: POOL_MANAGER_ABI, functionName: "shares", args: [poolId] });
console.log("step 1 — market created (the RFQ). poolId:", poolId, "cST:", cst);
await waitForPool(poolId);

// One-time setup, both parties (the approval matrix from the README):
//   asker pays premiums          → CA -> LOP
//   underwriter JIT-mints        → CA -> adapter, cST -> LOP
// CONTRACT parties also get funded with CA from their owner EOA here.
const collateralNeeded = await asker.client.readContract({
  address: poolManager, abi: POOL_MANAGER_ABI, functionName: "previewMint", args: [poolId, sizeCst],
});
const maxPremium = premiumFor(ceilingPrice);
if (asker.type === "CONTRACT") {
  await send(asker, "fund asker wallet with CA", { address: E.CA, abi: ERC20_ABI, functionName: "transfer", args: [asker.address, maxPremium] });
}
if (underwriter.type === "CONTRACT") {
  await send(underwriter, "fund underwriter wallet with CA", { address: E.CA, abi: ERC20_ABI, functionName: "transfer", args: [underwriter.address, collateralNeeded] });
}
await act(asker, "approve CA -> LOP", { address: E.CA, abi: ERC20_ABI, functionName: "approve", args: [LOP_ADDRESS, maxPremium] });
await act(underwriter, "approve CA -> adapter", { address: E.CA, abi: ERC20_ABI, functionName: "approve", args: [E.ADAPTER, collateralNeeded] });
await act(underwriter, "approve cST -> LOP", { address: cst, abi: ERC20_ABI, functionName: "approve", args: [LOP_ADDRESS, sizeCst] });

// ═════ Step 2 — asker posts the opening bid (plain-shaped BUY) ═══════════════
// makerAsset = CA (premium offered), takerAsset = cST (size wanted). No
// extension: taker-side JIT is the underwriter's own unsigned choice at lift
// time. Expiry mandatory — this bid may be superseded, never cancelled.
const expirySeconds = Number(E.EXPIRY_SECONDS ?? 3600);
const bidExpiry = orderExpiry(expirySeconds, await chainNow());
const bidNonce = BigInt(Math.floor(Date.now() / 1000)) & ((1n << 40n) - 1n);
const bid = {
  salt: BigInt(Date.now()),
  maker: asker.address,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: E.CA,
  takerAsset: cst,
  makingAmount: premiumFor(bidPrice),
  takingAmount: sizeCst,
  makerTraits: buildMakerTraits({ expiry: bidExpiry, nonce: bidNonce, allowPartialFills: true, allowMultipleFills: true }),
};
const bidSigned = await signOrder(asker, bid);
await publishOrder(orderPayload(asker, bid, bidSigned, "BUY", "", bidExpiry, bidNonce, poolId));
console.log(`step 2 — opening bid posted at ${bidPrice} CA/cST:`, bidSigned.orderHash);

// ═════ Step 3 — underwriter discovers and prices ═════════════════════════════
const bids = await discoverOrders(poolId, "BUY", await chainNow());
if (!bids.length) failWith("discovery", new Error("no bids resting on this market"));
const restingBid = bids[0];
const restingBidPrice = Number(restingBid.makingAmount) / Number(restingBid.takingAmount) / Number(10n ** caDecimals) * 1e18;
console.log(`step 3 — underwriter sees the bid at ~${restingBidPrice.toFixed(6)} CA/cST (floor ${floorPrice})`);

// ═════ Step 4 — bid below floor → COUNTER with a new JIT ask ═════════════════
// The counter is a NEW order at the underwriter's price — no cancel exists in
// the flow. Both orders now rest; the superseded bid dies only by expiry.
if (restingBidPrice >= floorPrice) failWith("negotiation", new Error("bid already clears the floor — this walkthrough expects the counter path"));
const extension = buildExtension({ preInteractionData: packTargetAndData(E.ADAPTER, poolId) });
const askExpiry = orderExpiry(expirySeconds, await chainNow());
const askNonce = (BigInt(Math.floor(Date.now() / 1000)) + 1n) & ((1n << 40n) - 1n);
const ask = {
  salt: saltForExtension(extension),
  maker: underwriter.address,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: cst,
  takerAsset: E.CA,
  makingAmount: sizeCst,
  takingAmount: premiumFor(counterPrice),
  makerTraits: buildMakerTraits({
    expiry: askExpiry,
    nonce: askNonce,
    allowPartialFills: true,
    allowMultipleFills: true,
    hasExtension: true,
    preInteraction: true, // the signed JIT commitment: mint my cST at fill
  }),
};
const askSigned = await signOrder(underwriter, ask);
await publishOrder(orderPayload(underwriter, ask, askSigned, "SELL", extension, askExpiry, askNonce, poolId));
console.log(`step 4 — counter-ask posted at ${counterPrice} CA/cST:`, askSigned.orderHash);

// ═════ Step 5 — asker discovers the counter and fills it ═════════════════════
const asks = await discoverOrders(poolId, "SELL", await chainNow());
if (!asks.length) failWith("discovery", new Error("no asks resting on this market"));
const restingAsk = asks[0];
const restingAskPrice = Number(restingAsk.takingAmount) / Number(restingAsk.makingAmount) / Number(10n ** caDecimals) * 1e18;
if (restingAskPrice > ceilingPrice) failWith("negotiation", new Error(`ask ${restingAskPrice} above ceiling ${ceilingPrice}`));

// The fill branch of the makerAccountType rule, driven by the BOOK's field —
// never by assumption. The taker (the asker) may itself be a CONTRACT, in
// which case the fill call goes through its wallet too.
const { traits, args } = buildTakerTraits({
  makerAmount: true,
  threshold: BigInt(restingAsk.takingAmount),
  extensionHex: restingAsk.extension && restingAsk.extension !== "" ? restingAsk.extension : "0x",
});
const orderStruct = {
  salt: BigInt(restingAsk.salt),
  maker: hexToBigInt(restingAsk.maker),
  receiver: hexToBigInt(restingAsk.receiver),
  makerAsset: hexToBigInt(restingAsk.makerAsset),
  takerAsset: hexToBigInt(restingAsk.takerAsset),
  makingAmount: BigInt(restingAsk.makingAmount),
  takingAmount: BigInt(restingAsk.takingAmount),
  makerTraits: BigInt(restingAsk.makerTraits),
};
if (restingAsk.makerAccountType === "CONTRACT") {
  await act(asker, "fillContractOrderArgs", {
    address: LOP_ADDRESS,
    abi: FILL_CONTRACT_ORDER_ARGS_ABI,
    functionName: "fillContractOrderArgs",
    args: [orderStruct, restingAsk.signature, BigInt(restingAsk.makingAmount), traits, args],
  });
} else {
  const { r, vs } = toCompactSignature(restingAsk.signature);
  await act(asker, "fillOrderArgs", {
    address: LOP_ADDRESS,
    abi: FILL_ORDER_ARGS_ABI,
    functionName: "fillOrderArgs",
    args: [orderStruct, r, vs, BigInt(restingAsk.makingAmount), traits, args],
  });
}
markFilled(restingAsk.orderHash);
console.log("step 5 — filled", restingAsk.orderHash, `(maker was ${restingAsk.makerAccountType})`);

// ═════ End state ═════════════════════════════════════════════════════════════
const askerCst = await asker.client.readContract({ address: cst, abi: ERC20_ABI, functionName: "balanceOf", args: [asker.address] });
if (askerCst !== sizeCst) failWith("end state", new Error(`asker holds ${askerCst} cST, expected ${sizeCst}`));
console.log(`done — asker holds its ${askerCst} cST cover; underwriter keeps cPT + premium.`);
console.log(`note: the superseded opening bid ${bidSigned.orderHash} stays fillable until its expiry (${new Date(bidExpiry * 1000).toISOString()}).`);
