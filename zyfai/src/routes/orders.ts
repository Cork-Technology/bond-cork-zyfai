import { Router } from 'express';
import { getWalletInfo } from '../services/wallet.js';
import { listSafeOrders } from '../services/corkOrders.js';

export const ordersRouter = Router();

ordersRouter.get('/', async (req, res) => {
  try {
    const { smartWalletAddress } = await getWalletInfo();
    const poolId = typeof req.query.poolId === 'string' ? req.query.poolId : undefined;
    const side = req.query.side === 'BUY' || req.query.side === 'SELL' ? req.query.side : undefined;
    const orders = await listSafeOrders(smartWalletAddress, poolId as `0x${string}` | undefined, side);
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: 'failed_to_list_orders', message: (err as Error).message });
  }
});
