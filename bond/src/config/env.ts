import 'dotenv/config';
import { z } from 'zod';
import type { Hex } from 'viem';

const hexAddress = z
  .custom<Hex>((val) => typeof val === 'string' && /^0x[a-fA-F0-9]{40}$/u.test(val), {
    message: 'Must be a 0x-prefixed 20-byte hex address',
  });

const PLACEHOLDER_PRIVATE_KEY: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111';

const hexPrivateKey = z
  .custom<Hex>((val) => typeof val === 'string' && /^0x[a-fA-F0-9]{64}$/u.test(val), {
    message: 'Must be a 0x-prefixed 32-byte hex string (64 hex chars)',
  })
  .refine((val) => val !== '0x0000000000000000000000000000000000000000000000000000000000000000', {
    message: 'Private key cannot be all zeros',
  })
  .refine((val) => val !== PLACEHOLDER_PRIVATE_KEY, {
    message: 'Replace the placeholder BOND_EOA_PRIVATE_KEY in .env',
  });

const hexBytes32 = z
  .custom<Hex>((val) => typeof val === 'string' && /^0x[a-fA-F0-9]{64}$/u.test(val), {
    message: 'Must be a 0x-prefixed 32-byte hex string',
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  RPC_URL: z.string().url('RPC_URL must be a valid URL'),
  CORK_API_URL: z.string().url('CORK_API_URL must be a valid URL').default('https://api-phoenix.cork.tech'),

  BOND_EOA_PRIVATE_KEY: hexPrivateKey,

  CORK_MARKET_CREATOR: hexAddress,
  FIXED_RATE_ORACLE_FACTORY: hexAddress,
  CORK_LIMIT_ORDER_ADAPTER: hexAddress,
  ONE_INCH_LOP_V4: hexAddress,

  CORK_POOL_MANAGER: hexAddress,
  DEFAULT_CORK_CONTROLLER: hexAddress,
  CORK_ADAPTER: hexAddress,
  WHITELIST_MANAGER: hexAddress,
  CONSTRAINT_RATE_ADAPTER: hexAddress,
  SHARES_FACTORY: hexAddress,

  CA_TOKEN: hexAddress,
  CA_DECIMALS: z.coerce.number().int().positive().default(6),

  REF_TOKEN: hexAddress,
  REF_DECIMALS: z.coerce.number().int().positive().default(18),

  DEMAND_MAKER_ADDRESS: hexAddress,

  FLOOR_PREMIUM_BPS: z.coerce.number().int().min(0).max(10000).default(50),
  COUNTER_MARGIN_BPS: z.coerce.number().int().min(0).max(10000).default(10),
  MAX_CA_POSITION: z.coerce.bigint().default(1_000_000_000n),
  ORDER_LIFETIME_SECONDS: z.coerce.number().int().positive().default(600),
  DEFAULT_SWAP_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(100),
  DEFAULT_UNWIND_SWAP_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(200),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
