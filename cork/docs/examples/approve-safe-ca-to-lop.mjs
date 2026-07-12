// Approve CA (e.g. USDC) from the Zyfai Safe to the 1inch LOP v4 contract.
// This is a prerequisite for posting a Safe maker bid; without it the fill
// reverts with TransferFromMakerToTakerFailed.
//
// This script sends a batched call to the Zyfai /tx endpoint, which signs and
// submits a sponsored userOp from the Safe.
//
// env: SAFE_ADDRESS     the Safe smart wallet that holds CA
//      CA               the collateral asset (e.g. USDC on Arbitrum)
//      ZYFAI_TX_URL     http://localhost:3000/tx (or wherever zyfai runs)

import { encodeFunctionData, parseAbi, isAddress } from "viem";

const LOP_ADDRESS = "0x111111125421cA6dc452d289314280a0f8842A65";

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
const ca = requireAddress("CA");
const zyfaiUrl = process.env.ZYFAI_TX_URL ?? "http://localhost:3000/tx";

// Approve a generous amount (1_000 USDC in 6 decimals). Adjust if you plan to
// post larger test bids, or use uint256.max for an unlimited approval.
const CA_DECIMALS = Number(process.env.CA_DECIMALS ?? "6");
const approveAmount = BigInt(process.env.APPROVE_AMOUNT ?? 1_000n * 10n ** BigInt(CA_DECIMALS));

const data = encodeFunctionData({
  abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
  functionName: "approve",
  args: [LOP_ADDRESS, approveAmount],
});

const body = {
  calls: [
    {
      to: ca,
      value: "0",
      data,
    },
  ],
  waitForReceipt: true,
};

console.log("Requesting Safe approval tx...");
console.log("  Safe:", safeAddress);
console.log("  Token:", ca);
console.log("  Spender:", LOP_ADDRESS);
console.log("  Amount:", approveAmount.toString());

const res = await fetch(zyfaiUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const result = await res.json();
if (!res.ok) {
  console.error("Approval failed:", res.status, result);
  process.exit(1);
}

console.log("Approval userOp submitted:");
console.log(JSON.stringify(result, null, 2));
