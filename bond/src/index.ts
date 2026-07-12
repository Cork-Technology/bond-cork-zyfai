import { env } from './config/env.js';
import { logger } from './logger.js';
import { startDiscoveryLoop } from './engine/discovery.js';
import { BOND_ADDRESS } from './services/chain.js';
import { startServer } from './server.js';

const controller = new AbortController();

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down gracefully');
  controller.abort();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main(): Promise<void> {
  logger.info(
    {
      nodeEnv: env.NODE_ENV,
      bondAddress: BOND_ADDRESS,
      caToken: env.CA_TOKEN,
      refToken: env.REF_TOKEN,
      floorPremiumBps: env.FLOOR_PREMIUM_BPS,
      counterMarginBps: env.COUNTER_MARGIN_BPS,
      maxCaPosition: env.MAX_CA_POSITION.toString(),
    },
    'Bond underwriting agent starting',
  );

  startServer();
  await startDiscoveryLoop(controller.signal);
}

main().catch((err) => {
  logger.fatal({ err }, 'unhandled error in main');
  process.exit(1);
});
