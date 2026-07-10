import { pino } from 'pino';
import { env } from './config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'zyfai-agent-server' },
  // Pretty-print in development for readability; keep JSON in production.
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
