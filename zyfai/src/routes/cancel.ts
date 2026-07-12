import { Router } from 'express';
import { isAddress, type Hex } from 'viem';
import { cancelSafeOrder, type CancelOrderInput } from '../services/corkOrders.js';

function requireAddress(body: Record<string, unknown>, key: string): Hex {
  const value = body[key];
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`Invalid or missing address: ${key}`);
  }
  return value;
}

function requireBigInt(body: Record<string, unknown>, key: string): bigint {
  const value = body[key];
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  throw new Error(`Invalid or missing bigint: ${key}`);
}

export const cancelRouter = Router();

cancelRouter.post('/', async (req, res) => {
  try {
    const b = req.body as Record<string, unknown>;

    const order: CancelOrderInput = {
      salt: requireBigInt(b, 'salt'),
      maker: requireAddress(b, 'maker'),
      receiver: requireAddress(b, 'receiver'),
      makerAsset: requireAddress(b, 'makerAsset'),
      takerAsset: requireAddress(b, 'takerAsset'),
      makingAmount: requireBigInt(b, 'makingAmount'),
      takingAmount: requireBigInt(b, 'takingAmount'),
      makerTraits: requireBigInt(b, 'makerTraits'),
    };

    const result = await cancelSafeOrder(order);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'failed_to_cancel_order', message: (err as Error).message });
  }
});
