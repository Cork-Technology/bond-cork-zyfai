// Create a Cork market (no opening bid). Returns the new poolId + share tokens.
//
// env: PRIVATE_KEY      EOA with ETH for gas (must hold no sUSDe for this step)
//      RPC_URL
//      MARKET_CREATOR   0x4B5B91cF4d1DAdb7439beB68926c86D2D8C68dBC
//      CA               collateral asset (e.g. sUSDe)
//      REF              reference asset (e.g. yoUSD)
//      RATE             decimal value of 1 REF in CA (e.g. "1")
//      MARKET_LIFETIME_SECONDS (default 86400)
//      SWAP_FEE_PCT     default 1
//      UNWIND_FEE_PCT   default 2

import { createWalletClient, http, parseEventLogs, parseUnits, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { failWith } from "./lib.mjs";

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
    outputs: [
      { name: "principalToken", type: "address" },
      { name: "swapToken", type: "address" },
    ],
  },
];

const E = process.env;
const account = privateKeyToAccount(E.PRIVATE_KEY);
const client = createWalletClient({ account, chain: arbitrum, transport: http(E.RPC_URL) }).extend(publicActions);

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
        swapFeePercentage: parseUnits(E.SWAP_FEE_PCT ?? "1", 18),
        unwindSwapFeePercentage: parseUnits(E.UNWIND_FEE_PCT ?? "2", 18),
        isWhitelistEnabled: false,
      },
    ],
  });
  receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`createMarket reverted (${hash})`);
} catch (error) {
  failWith("createMarket", error);
}

const [created] = parseEventLogs({ abi: CREATOR_ABI, eventName: "MarketCreated", logs: receipt.logs });
const poolId = created.args.id;
const poolManager = await client.readContract({ address: E.MARKET_CREATOR, abi: CREATOR_ABI, functionName: "poolManager" });
const [cpt, cst] = await client.readContract({ address: poolManager, abi: POOL_MANAGER_ABI, functionName: "shares", args: [poolId] });

console.log("market created");
console.log("poolId:", poolId);
console.log("oracle:", created.args.oracle);
console.log("cPT (principal):", cpt);
console.log("cST (swap/cover):", cst);
