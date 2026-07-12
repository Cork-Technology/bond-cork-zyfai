export const swaggerSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Zyfai Agent API',
    version: '0.1.0',
    description:
      'ERC-4337 Safe smart-wallet API for the bond.credit × Cork × Zyfai hackathon pilot.',
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Local development server',
    },
  ],
  tags: [
    { name: 'Health', description: 'Liveness checks' },
    { name: 'Wallet', description: 'Smart-wallet info' },
    { name: 'Transactions', description: 'Submit user operations' },
    { name: 'Orders', description: 'Cork Phoenix limit orders' },
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
                    uptime: { type: 'number' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/wallet': {
      get: {
        tags: ['Wallet'],
        summary: 'Get smart wallet info',
        responses: {
          '200': {
            description: 'Smart wallet metadata',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    smartWalletAddress: { type: 'string' },
                    ownerAddress: { type: 'string' },
                    chainId: { type: 'number' },
                    chainName: { type: 'string' },
                    isDeployed: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/tx': {
      post: {
        tags: ['Transactions'],
        summary: 'Submit one or more calls as a sponsored user operation',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['calls'],
                properties: {
                  calls: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['to'],
                      properties: {
                        to: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
                        value: { type: 'string' },
                        data: { type: 'string' },
                      },
                    },
                  },
                  waitForReceipt: { type: 'boolean', default: false },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'UserOp submitted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    userOpHash: { type: 'string' },
                    receipt: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/orders': {
      get: {
        tags: ['Orders'],
        summary: 'List open orders created by the Safe',
        parameters: [
          {
            name: 'poolId',
            in: 'query',
            schema: { type: 'string' },
            description: 'Optional pool id filter',
          },
          {
            name: 'side',
            in: 'query',
            schema: { type: 'string', enum: ['BUY', 'SELL'] },
            description: 'Optional side filter',
          },
        ],
        responses: {
          '200': {
            description: 'List of orders',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    orders: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/bid': {
      post: {
        tags: ['Orders'],
        summary: 'Post a BUY bid for cST cover from the Safe',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['poolId', 'ca', 'cst', 'caDecimals', 'sizeCst', 'priceCaPerCst'],
                properties: {
                  poolId: { type: 'string' },
                  ca: { type: 'string' },
                  cst: { type: 'string' },
                  caDecimals: { type: 'number' },
                  sizeCst: { type: 'string' },
                  priceCaPerCst: { type: 'number' },
                  premiumDisplay: { type: 'number' },
                  expirySeconds: { type: 'number' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Bid posted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    orderHash: { type: 'string' },
                    signature: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/cancel': {
      post: {
        tags: ['Orders'],
        summary: 'Cancel an order via the Safe',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['salt', 'maker', 'receiver', 'makerAsset', 'takerAsset', 'makingAmount', 'takingAmount', 'makerTraits'],
                properties: {
                  salt: { type: 'string' },
                  maker: { type: 'string' },
                  receiver: { type: 'string' },
                  makerAsset: { type: 'string' },
                  takerAsset: { type: 'string' },
                  makingAmount: { type: 'string' },
                  takingAmount: { type: 'string' },
                  makerTraits: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Cancellation submitted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    userOpHash: { type: 'string' },
                    txHash: { type: 'string' },
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
