// Exercise cST cover from the Safe (Zyfai) against the Cork pool.
//
// This simulates a depeg payout: the Safe hands in 1 cST + 1 yoUSD and receives
// sUSDe collateral back at the oracle rate (minus the swap fee).
//
// env: SAFE_ADDRESS     the Safe smart wallet
//      POOL_ID          the Cork pool id
//      POOL_MANAGER     0xc2De56fb1C7a85250ce69C37B4773767C77954AE
//      CST              the pool's swapToken (cST)
//      REF              the reference asset (yoUSD)
//      CST_SHARES       cST amount to exercise (default 1e18)
//      ZYFAI_TX_URL     default http://localhost:3000/tx

import { encodeFunctionData, parseAbi, isAddress } from "viem";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function requireAddress(name) {
  const value = requireEnv(name);
  if (!isAddress(value)) throw new Error(`Invalid address in ${name}: ${value}`);
  return value;
}

const safeAddress = requireAddress("SAFE_ADDRESS");
const poolId = requireEnv("POOL_ID");
const poolManager = requireAddress("POOL_MANAGER");
const cst = requireAddress("CST");
const ref = requireAddress("REF");
const cstShares = BigInt(process.env.CST_SHARES ?? "1000000000000000000");
const zyfaiUrl = process.env.ZYFAI_TX_URL ?? "http://localhost:3000/tx";

const approveCst = encodeFunctionData({
  abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
  functionName: "approve",
  args: [poolManager, cstShares],
});

const approveRef = encodeFunctionData({
  abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
  functionName: "approve",
  args: [poolManager, 10n ** 18n], // generous allowance for the reference asset
});

const exercise = encodeFunctionData({
  abi: parseAbi([
    "function exercise(bytes32 poolId, uint256 cstSharesIn, address receiver) returns (uint256 collateralAssetsOut, uint256 referenceAssetsIn, uint256 fee)",
  ]),
  functionName: "exercise",
  args: [poolId, cstShares, safeAddress],
});

const body = {
  calls: [
    { to: cst, value: "0", data: approveCst },
    { to: ref, value: "0", data: approveRef },
    { to: poolManager, value: "0", data: exercise },
  ],
  waitForReceipt: true,
};

console.log("Requesting Safe exercise tx...");
console.log("  Safe:", safeAddress);
console.log("  Pool:", poolId);
console.log("  cST in:", cstShares.toString());

const res = await fetch(zyfaiUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const result = await res.json();
if (!res.ok) {
  console.error("Exercise failed:", res.status, result);
  process.exit(1);
}

console.log("Exercise userOp submitted:");
console.log(JSON.stringify(result, null, 2));
