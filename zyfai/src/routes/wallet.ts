import { Router } from 'express';
import { getWalletInfo } from '../services/wallet.js';
import { logger } from '../logger.js';

export const walletRouter = Router();

walletRouter.get('/', async (_req, res) => {
  try {
    const info = await getWalletInfo();
    res.json(info);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to fetch wallet info');
    res.status(500).json({ error: 'wallet_info_failed', message });
  }
});
