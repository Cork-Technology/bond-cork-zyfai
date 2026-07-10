import express, { type Express } from 'express';
import { healthRouter } from './routes/health.js';
import { walletRouter } from './routes/wallet.js';
import { txRouter } from './routes/tx.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.use('/health', healthRouter);
  app.use('/wallet', walletRouter);
  app.use('/tx', txRouter);

  // Fallback for unknown routes.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}
