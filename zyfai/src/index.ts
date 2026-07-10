import { env } from './config/env.js';
import { logger } from './logger.js';
import { initWallet } from './services/wallet.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  await initWallet();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, nodeEnv: env.NODE_ENV },
      `Zyfai agent server listening on http://localhost:${env.PORT}`,
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down gracefully');
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'Error during server shutdown');
        process.exit(1);
      }
      process.exit(0);
    });
    // Force-exit if not closed within 10s.
    setTimeout(() => {
      logger.warn('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
