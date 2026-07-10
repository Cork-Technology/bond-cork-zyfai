# Zyfai Agent Server

Express server exposing an **ERC-4337 Safe smart wallet** on **Arbitrum One**, controlled by a **shared EOA** and sponsored by **Pimlico** (paymaster). This is the Zyfai side of the `bond.credit × Cork × Zyfai` hackathon pilot at Arbitrum Open House London.

For the full project context (what the three teams are building together and how the pieces fit), see [`PROJECT.md`](../PROJECT.md).

---

## What this server does

- Instantiates a **Safe 4337 smart account** (v1.4.1, EntryPoint v0.7) owned by a single EOA loaded from env
- Exposes a **generic HTTP API** so any teammate (bond.credit keeper, Cork market service) can:
  - Read the smart wallet address (to whitelist it on their side)
  - Send arbitrary batched calls from the smart wallet
- All userOps are **gas-sponsored by Pimlico** — the smart wallet never needs to hold ETH

The smart account is intentionally minimal: the shared EOA is the sole owner and signs every userOp. No Rhinestone attesters, no OwnableValidator module, no session keys.

---

## Requirements

- **Node.js 20+**
- A **Pimlico API key** (with credits on Arbitrum One)
- An **Arbitrum One RPC endpoint** (Alchemy, Infura, etc.)
- A **32-byte EOA private key** that will be shared with your teammates

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure env
cp .env.example .env
# then edit .env and fill:
#   - SHARED_EOA_PRIVATE_KEY
#   - PIMLICO_API_KEY
#   - ALCHEMY_RPC_URL

# 3. Run the dev server (watch mode)
npm run dev
```

On startup, the server logs the smart wallet address so you can share it with bond and Cork immediately:

```
Smart wallet initialized
  smartWalletAddress: 0xabc...
  ownerAddress: 0xdef...
  chainId: 42161
  chainName: Arbitrum One
  isDeployed: false
Zyfai agent server listening on http://localhost:3000
```

`isDeployed: false` is expected before the first tx — the address is deterministic and known in advance thanks to the CREATE2 factory. The smart wallet gets deployed automatically on the first userOp (or you can pre-deploy it manually).

---

## API

All endpoints return JSON. There is **no authentication** — the server is meant to run on a private/trusted network for the hackathon.

### `GET /health`

Health probe.

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok", "uptime": 12.34, "timestamp": "2026-07-10T06:00:00.000Z" }
```

### `GET /wallet`

Returns the smart wallet address and its current on-chain state.

```bash
curl http://localhost:3000/wallet
```

```json
{
  "smartWalletAddress": "0xabc...",
  "ownerAddress": "0xdef...",
  "chainId": 42161,
  "chainName": "Arbitrum One",
  "isDeployed": false
}
```

### `POST /tx`

Sends a batch of calls from the smart wallet. Sponsored by Pimlico.

**Body:**

```json
{
  "calls": [
    { "to": "0x...", "value": "0", "data": "0x..." },
    { "to": "0x...", "data": "0x..." }
  ],
  "waitForReceipt": true
}
```

- `calls[].to` — target contract (0x-prefixed 20-byte address, required)
- `calls[].value` — wei amount as string or number (optional, default `0`)
- `calls[].data` — calldata as 0x-prefixed hex (optional, default `0x`)
- `waitForReceipt` — if `true`, waits for the userOp to be included on-chain before responding (optional, default `false`)

**Response (waitForReceipt = false):**

```json
{ "userOpHash": "0x..." }
```

**Response (waitForReceipt = true):**

```json
{
  "userOpHash": "0x...",
  "receipt": {
    "transactionHash": "0x...",
    "blockNumber": "123456789",
    "success": true
  }
}
```

**Example — self-call with empty data (cheap way to force deployment):**

```bash
curl -X POST http://localhost:3000/tx \
  -H 'content-type: application/json' \
  -d '{
    "calls": [{ "to": "0xYOUR_SMART_WALLET", "value": "0", "data": "0x" }],
    "waitForReceipt": true
  }'
```

---

## Scripts

| Command             | Description                                    |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Run the server with `tsx` in watch mode        |
| `npm run build`     | Compile TypeScript to `dist/`                  |
| `npm run start`     | Run the built server (`node dist/index.js`)    |
| `npm run typecheck` | Type-check without emitting                    |
| `npm run lint`      | Run ESLint                                     |
| `npm run format`    | Format `src/` and root `*.md` files            |

---

## Project structure

```
src/
  config/
    env.ts          # zod-validated environment
  services/
    wallet.ts       # Safe 4337 + Pimlico paymaster (permissionless + viem)
  routes/
    health.ts       # GET /health
    wallet.ts       # GET /wallet
    tx.ts           # POST /tx
  logger.ts         # pino
  app.ts            # Express factory
  index.ts          # entry point (init + listen + graceful shutdown)
```

---

## Security notes (read before running in any shared environment)

- `SHARED_EOA_PRIVATE_KEY` is a **hackathon-only** key. It's shared across the bond / Cork / Zyfai teams. Do **not** reuse it for any production or personal wallet.
- There is **no HTTP auth** on the API. Do **not** expose the server publicly without adding auth (or restricting network access via firewall / tunnel).
- Rotate the key immediately after the hackathon.
- The smart wallet's on-chain owner is the EOA above. Anyone with the key can move funds out of the smart wallet through any signer.

---

## Stack

- Node 20 · TypeScript strict · ESM
- Express 4
- [viem](https://viem.sh) + [permissionless.js](https://docs.pimlico.io/permissionless) (Safe 4337 account)
- [Pimlico](https://www.pimlico.io) bundler + paymaster
- zod (validation), pino (logging)
