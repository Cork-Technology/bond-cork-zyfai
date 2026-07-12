import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { healthRouter } from './routes/health.js';
import { walletRouter } from './routes/wallet.js';
import { txRouter } from './routes/tx.js';
import { ordersRouter } from './routes/orders.js';
import { bidRouter } from './routes/bid.js';
import { cancelRouter } from './routes/cancel.js';
import { swaggerSpec } from './openapi.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  app.use('/health', healthRouter);
  app.use('/wallet', walletRouter);
  app.use('/tx', txRouter);
  app.use('/orders', ordersRouter);
  app.use('/bid', bidRouter);
  app.use('/cancel', cancelRouter);

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/openapi.json', (_req, res) => res.json(swaggerSpec));

  // Fallback for unknown routes.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}
