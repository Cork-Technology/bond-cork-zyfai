import 'dotenv/config';
import { z } from 'zod';

const hexPrivateKey = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/u, 'Must be a 0x-prefixed 32-byte hex string (64 hex chars)');

const hexAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/u, 'Must be a 0x-prefixed 20-byte hex address');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  SHARED_EOA_PRIVATE_KEY: hexPrivateKey,
  PIMLICO_API_KEY: z.string().min(1, 'PIMLICO_API_KEY is required'),
  ALCHEMY_RPC_URL: z.string().url('ALCHEMY_RPC_URL must be a valid URL'),

  // Rhinestone SDK (orchestrator + sponsored intents). Required by `provision:account`.
  RHINESTONE_API_KEY: z.string().min(1).optional(),

  // Session-key bootstrap (optional at server start; required by scripts under src/scripts/).
  BASE_RPC_URL: z.string().url('BASE_RPC_URL must be a valid URL').optional(),
  SAFE_SALT_NONCE: z.coerce.bigint().default(1n),
  IMPLEMENTATION_GUARD_MODULE: hexAddress.optional(),
  GUARD_MODULE: hexAddress.optional(),
  TARGET_REGISTRY: hexAddress.optional(),
  SESSION_KEY_PRIVATE_KEY: hexPrivateKey.optional(),
  DUMMY_APPROVE_TOKEN: hexAddress.optional(),
  DUMMY_APPROVE_SPENDER: hexAddress.optional(),

  // Cork cover loop (src/scripts/cover.ts). Cork Phoenix is live on Ethereum (1) and Arbitrum One
  // (42161) only — `cork_query protocol-config` returns `unknown_deployment` for any other chain.
  CORK_CHAIN_ID: z.coerce.number().int().positive().default(42161),
  CORK_RPC_URL: z.string().url('CORK_RPC_URL must be a valid URL').optional(),
  CORK_LOP: hexAddress.default('0x111111125421cA6dc452d289314280a0f8842A65'),
  CORK_POOL_MANAGER: hexAddress.optional(),
  CORK_ADAPTER: hexAddress.optional(),
  CORK_BUNDLER3: hexAddress.optional(),
  // The pair being covered: REF is the asset the user is exposed to (e.g. an ERC-4626 vault share),
  // CA is what the Safe receives on exercise.
  COVER_REF: hexAddress.optional(),
  COVER_CA: hexAddress.optional(),
  COVER_CST: hexAddress.optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Print a human-readable error and exit; do not proceed with a broken config.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
