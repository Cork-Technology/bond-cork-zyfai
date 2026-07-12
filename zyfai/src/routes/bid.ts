import { Router } from 'express';
import { isAddress } from 'viem';
import { env } from '../config/env.js';
import { getWalletInfo } from '../services/wallet.js';
import { postSafeBid } from '../services/corkOrders.js';

export const bidRouter = Router();

bidRouter.post('/', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;

    const poolId = typeof body.poolId === 'string' ? body.poolId : undefined;
    const ca = typeof body.ca === 'string' && isAddress(body.ca) ? body.ca : undefined;
    const cst = typeof body.cst === 'string' && isAddress(body.cst) ? body.cst : undefined;
    const caDecimals = typeof body.caDecimals === 'number' ? body.caDecimals : undefined;
    const sizeCst = typeof body.sizeCst === 'string' ? BigInt(body.sizeCst) : undefined;
    const priceCaPerCst = typeof body.priceCaPerCst === 'number' ? body.priceCaPerCst : undefined;

    if (!poolId || !ca || !cst || caDecimals == null || !sizeCst || priceCaPerCst == null) {
      return res.status(400).json({ error: 'missing_or_invalid_fields' });
    }

    const { smartWalletAddress } = await getWalletInfo();
    const result = await postSafeBid(
      {
        poolId: poolId as `0x${string}`,
        ca,
        cst,
        caDecimals,
        sizeCst,
        priceCaPerCst,
        premiumDisplay: typeof body.premiumDisplay === 'number' ? body.premiumDisplay : undefined,
        expirySeconds: typeof body.expirySeconds === 'number' ? body.expirySeconds : undefined,
      },
      smartWalletAddress,
      env.SHARED_EOA_PRIVATE_KEY as `0x${string}`,
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'failed_to_post_bid', message: (err as Error).message });
  }
});
