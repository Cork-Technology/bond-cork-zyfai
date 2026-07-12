export const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Bond Underwriting Agent API',
    version: '0.1.0',
    description:
      'Read-only status and position API for the Bond underwriting agent in the bond.credit × Cork × Zyfai hackathon pilot.',
  },
  servers: [
    {
      url: 'http://localhost:4000',
      description: 'Local development server',
    },
  ],
  tags: [
    { name: 'Health', description: 'Liveness checks' },
    { name: 'Status', description: 'Agent configuration and decisions' },
    { name: 'Position', description: 'On-chain exposure and fills' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/status': {
      get: {
        tags: ['Status'],
        summary: 'Agent status and recent decisions',
        responses: {
          '200': {
            description: 'Agent status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    bondAddress: { type: 'string' },
                    caToken: { type: 'string' },
                    refToken: { type: 'string' },
                    caDecimals: { type: 'number' },
                    refDecimals: { type: 'number' },
                    floorPremiumBps: { type: 'number' },
                    counterMarginBps: { type: 'number' },
                    maxCaPosition: { type: 'string' },
                    chainId: { type: 'number' },
                    blockTimestamp: { type: 'number' },
                    utilizationBps: { type: 'number' },
                    recentDecisions: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/position': {
      get: {
        tags: ['Position'],
        summary: 'Current on-chain position and fills',
        responses: {
          '200': {
            description: 'Position snapshot',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    bondAddress: { type: 'string' },
                    caBalance: { type: 'string' },
                    refBalance: { type: 'string' },
                    caLockedInOpenOrders: { type: 'string' },
                    caAtRiskFromFills: { type: 'string' },
                    caExposure: { type: 'string' },
                    maxCaPosition: { type: 'string' },
                    utilizationBps: { type: 'number' },
                    pools: { type: 'object' },
                    fills: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
