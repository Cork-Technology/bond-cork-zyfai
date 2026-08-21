/**
 * ERC20 approve from the Safe, through GUARD_MODULE.executeGuardedBatch.
 *
 * Usage:
 *   npx tsx src/scripts/approve-spender.ts --token 0x… --spender 0x… --amount <base-units>
 *
 * The spender must be registered on the TargetRegistry as an allowed ERC20
 * recipient for that token, and (token, approve) must be whitelisted.
 */
import { encodeFunctionData, erc20Abi } from 'viem';
import type { Address } from 'viem';

import { env } from '../config/env.js';
import { createSessionContext, type Execution } from '../services/session.js';

function isHex40(s: string): s is Address {
  return /^0x[a-fA-F0-9]{40}$/u.test(s);
}

function parseArgs(argv: string[]): { token: Address; spender: Address; amount: bigint } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const token = get('--token');
  const spender = get('--spender');
  const amount = get('--amount');

  if (!token || !isHex40(token)) throw new Error('--token <address> is required');
  if (!spender || !isHex40(spender)) throw new Error('--spender <address> is required');
  if (!amount || !/^\d+$/u.test(amount)) throw new Error('--amount <base-units> is required');

  return { token, spender, amount: BigInt(amount) };
}

async function main(): Promise<void> {
  const { token, spender, amount } = parseArgs(process.argv.slice(2));
  const rpcUrl = env.CORK_RPC_URL ?? env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error('CORK_RPC_URL or BASE_RPC_URL is required');

  const ctx = await createSessionContext({ chainId: env.CORK_CHAIN_ID, rpcUrl });

  const before = await ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ctx.safeAddress, spender],
  });

  console.log(`safe      ${ctx.safeAddress}`);
  console.log(`token     ${token}`);
  console.log(`spender   ${spender}`);
  console.log(`allowance ${before} -> ${amount}`);

  if (!(await ctx.isEnabled())) throw new Error('session not enabled — run provision:account first');

  const executions: Execution[] = [
    {
      target: token,
      value: 0n,
      callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    },
  ];

  const result = await ctx.sendGuardedBatch(executions);
  console.log(`\ntx        ${result.transactionHash}`);
  if (result.intentId) console.log(`intent    ${result.intentId}`);

  const after = await ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ctx.safeAddress, spender],
  });
  console.log(`allowance ${after}`);
  if (after !== amount) throw new Error(`allowance did not settle to ${amount}`);
}

main().catch((error: unknown) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
