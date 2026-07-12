import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { type Hex } from 'viem';
import { publicClient, BOND_ADDRESS, erc20Abi } from './services/chain.js';
import { book, caExposure } from './services/position.js';
import { recentDecisions } from './engine/discovery.js';
import { swaggerSpec } from './openapi.js';

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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/status', async (_req, res) => {
  const block = await publicClient.getBlock();
  res.json({
    bondAddress: BOND_ADDRESS,
    caToken: env.CA_TOKEN,
    refToken: env.REF_TOKEN,
    caDecimals: env.CA_DECIMALS,
    refDecimals: env.REF_DECIMALS,
    floorPremiumBps: env.FLOOR_PREMIUM_BPS,
    counterMarginBps: env.COUNTER_MARGIN_BPS,
    maxCaPosition: env.MAX_CA_POSITION.toString(),
    chainId: 42161,
    blockTimestamp: Number(block.timestamp),
    utilizationBps: Number((caExposure() * 10000n) / BigInt(env.MAX_CA_POSITION || 1)),
    recentDecisions: recentDecisions.map((d) => ({
      poolId: d.poolId,
      orderHash: d.orderHash,
      action: d.action,
      reason: d.reason,
      txHash: d.txHash,
      postedOrderHash: d.postedOrderHash,
    })),
  });
});

app.get('/position', async (_req, res) => {
  const [caBalance, refBalance] = await Promise.all([
    publicClient.readContract({ address: env.CA_TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [BOND_ADDRESS] }),
    publicClient.readContract({ address: env.REF_TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [BOND_ADDRESS] }),
  ]);

  const pools: Record<string, { poolId: Hex; cst: Hex; cpt: Hex; cstBalance: string; cptBalance: string }> = {};
  for (const [poolId, pos] of book.pools.entries()) {
    pools[poolId] = {
      poolId: pos.poolId,
      cst: pos.cst,
      cpt: pos.cpt,
      cstBalance: pos.cstBalance.toString(),
      cptBalance: pos.cptBalance.toString(),
    };
  }

  // Fetch fills where Bond was the taker.
  let fills: unknown[] = [];
  try {
    const url = new URL(`${env.CORK_API_URL}/v1/limit-orders/fills`);
    url.searchParams.set('chainId', '42161');
    url.searchParams.set('taker', BOND_ADDRESS);
    const apiRes = await fetch(url.toString());
    if (apiRes.ok) {
      const data = (await apiRes.json()) as { items: unknown[] };
      fills = data.items;
    }
  } catch (err) {
    logger.warn({ err }, 'failed to fetch Bond fills for /position');
  }

  res.json({
    bondAddress: BOND_ADDRESS,
    caBalance: caBalance.toString(),
    refBalance: refBalance.toString(),
    caLockedInOpenOrders: book.caLockedInOpenOrders.toString(),
    caAtRiskFromFills: book.caAtRiskFromFills.toString(),
    caExposure: caExposure().toString(),
    maxCaPosition: env.MAX_CA_POSITION.toString(),
    utilizationBps: Number((caExposure() * 10000n) / BigInt(env.MAX_CA_POSITION || 1)),
    pools,
    fills,
  });
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/openapi.json', (_req, res) => res.json(swaggerSpec));

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

export function startServer(port = env.PORT): Express {
  const server = app.listen(port, () => {
    logger.info({ port }, 'Bond status server listening');
  });
  return app;
}
