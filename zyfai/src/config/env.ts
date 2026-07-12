import 'dotenv/config';
import { z } from 'zod';

const hexPrivateKey = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/u, 'Must be a 0x-prefixed 32-byte hex string (64 hex chars)');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  SHARED_EOA_PRIVATE_KEY: hexPrivateKey,
  PIMLICO_API_KEY: z.string().min(1, 'PIMLICO_API_KEY is required'),
  ALCHEMY_RPC_URL: z.string().url('ALCHEMY_RPC_URL must be a valid URL'),
  ORDERBOOK_URL: z.string().url().default('https://api-phoenix.cork.tech'),
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
