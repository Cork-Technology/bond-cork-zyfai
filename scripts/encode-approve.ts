/**
 * Encode an ERC-20 `approve(spender, amount)` call for the Zyfai smart wallet.
 *
 * Usage:
 *   npx tsx scripts/encode-approve.ts <spender> [amount] [tokenAddress] [decimals]
 *
 * Defaults:
 *   amount       = 1
 *   tokenAddress = native USDC on Arbitrum One (0xaf88d0...)
 *   decimals     = 6
 *
 * Example (approve yourself as spender for 1 USDC):
 *   npx tsx scripts/encode-approve.ts 0xYourEOA 1
 */

import { encodeFunctionData, erc20Abi, isAddress, parseUnits, type Address } from 'viem';

const NATIVE_USDC_ARBITRUM: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

const [, , spenderArg, amountArg = '1', tokenArg, decimalsArg] = process.argv;

if (!spenderArg || !isAddress(spenderArg)) {
  console.error(
    'Usage: npx tsx scripts/encode-approve.ts <spender> [amount] [tokenAddress] [decimals]',
  );
  process.exit(1);
}

const token = (tokenArg ?? NATIVE_USDC_ARBITRUM) as Address;
if (!isAddress(token)) {
  console.error(`Invalid token address: ${token}`);
  process.exit(1);
}

const decimals = decimalsArg ? Number(decimalsArg) : 6;
if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
  console.error(`Invalid decimals: ${decimalsArg}`);
  process.exit(1);
}

const amount = parseUnits(amountArg, decimals);

const data = encodeFunctionData({
  abi: erc20Abi,
  functionName: 'approve',
  args: [spenderArg as Address, amount],
});

const body = {
  calls: [{ to: token, value: '0', data }],
  waitForReceipt: true,
};

console.log('--- Encoded call ---');
console.log(`token   : ${token}`);
console.log(`spender : ${spenderArg}`);
console.log(`amount  : ${amountArg} (raw: ${amount.toString()})`);
console.log(`data    : ${data}`);
console.log('');
console.log('--- POST /tx body (JSON) ---');
console.log(JSON.stringify(body, null, 2));
console.log('');
console.log('--- curl (copy-paste) ---');
console.log(
  `curl -X POST http://localhost:3000/tx \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(body)}'`,
);
