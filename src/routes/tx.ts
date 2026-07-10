import { Router } from 'express';
import { z } from 'zod';
import { sendCalls, type Call } from '../services/wallet.js';
import { logger } from '../logger.js';

export const txRouter = Router();

const hexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/u, 'Invalid 0x-prefixed 20-byte address');
const hexData = z.string().regex(/^0x[a-fA-F0-9]*$/u, 'Invalid 0x-prefixed hex string');
// Accept `value` as string or number to preserve precision for large amounts.
const bigintish = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return BigInt(v);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid bigint value' });
    return z.NEVER;
  }
});

const callSchema = z.object({
  to: hexAddress,
  value: bigintish.optional(),
  data: hexData.optional(),
});

const bodySchema = z.object({
  calls: z.array(callSchema).min(1, 'At least one call is required'),
  waitForReceipt: z.boolean().optional().default(false),
});

txRouter.post('/', async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_body', issues: parsed.error.issues });
  }

  const { calls, waitForReceipt } = parsed.data;
  const normalizedCalls: Call[] = calls.map((c) => ({
    to: c.to as `0x${string}`,
    value: c.value,
    data: c.data as `0x${string}` | undefined,
  }));

  try {
    logger.info({ callCount: normalizedCalls.length, waitForReceipt }, 'Sending userOp');
    const result = await sendCalls(normalizedCalls, waitForReceipt);
    logger.info({ userOpHash: result.userOpHash }, 'UserOp submitted');
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to send userOp');
    return res.status(500).json({ error: 'send_userop_failed', message });
  }
});
