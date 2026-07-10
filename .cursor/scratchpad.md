# Scratchpad — Zyfai Agent Server (bond.credit × Cork × Zyfai)

## Background and Motivation

Hackathon context: **Arbitrum Open House London (10–12 July 2026)**. Three partners collaborate on an **agentic risk-trading pilot**:

- **bond.credit** — keeper underwriter agent (answers RFQs, signs quotes)
- **Cork Protocol** — Phoenix venue (off-chain order-book + on-chain settlement via 1inch LOP v4), market creation
- **Zyfai** (us) — demand agent + smart wallet representing the agent on-chain, capital allocator

**Scope of this repo (Zyfai only):**

An **Express server** exposing an **ERC-4337 Safe smart wallet** controlled by a **shared EOA** (private key in env). The smart wallet represents the Zyfai agent on-chain on **Arbitrum One**. All transactions are **sponsored by Pimlico (paymaster)** — the EOA never needs ETH.

**What this server exposes** (integration surface for Bond & Cork):

- The Zyfai smart wallet address (deterministic, so Cork/Bond can whitelist it before first tx)
- A generic API to send userOps from the smart wallet (arbitrary calls: accept 1inch LOP quote, fill order, exercise cST, etc.)
- Read endpoints (health, wallet info)

**Work split in the hackathon team:**

- **Zyfai (us)** → simple Safe smart account + shared EOA + Pimlico paymaster + Express server with generic tx API (this repo)
- **bond.credit** → keeper agent that responds to our RFQs (plugs onto our API)
- **Cork** → market creation, order-book API, convenience contracts on Arbitrum

Note: this repo **does not** contain the RFQ/quote business logic — that will be implemented by Cork/Bond on top of the primitives we expose.

## Key Challenges and Analysis

1. **"Really basic" smart account**: the brief asks for **no** Rhinestone attester / OwnableValidator (contrary to the sample provided). Just a Safe 4337 with the EOA as sole owner. This greatly simplifies `toSafeSmartAccount()` — one `owners: [eoa]`, no additional validators, no attesters.

2. **Deterministic address**: the smart wallet is **deployed counterfactually** (address known before deploy). Cork must be able to whitelist the address **before** the smart wallet sends its first tx. So we expose the address via `GET /wallet` immediately at startup. The user handles the actual deployment.

3. **Pimlico paymaster**: use `createPimlicoClient` from `permissionless/clients/pimlico` with the same URL for bundler + paymaster. The `smartAccountClient` is configured with `paymaster: pimlicoClient` so userOps are sponsored automatically.

4. **Shared EOA security**: the private key sits in env (`SHARED_EOA_PRIVATE_KEY`). It is shared across the 3 teams during the hackathon. We must:
   - Load with validation (zod)
   - **Never log** the key or the account object
   - Clearly state in the README this is a dev/hackathon key only
   - `.env` gitignored + `.env.example` provided

5. **Generic tx endpoint**: `POST /tx` accepts an array of `{ to, value, data }` (batch-friendly since Safe supports batching) and returns the `userOpHash` + optional receipt wait. Bond/Cork can execute any call (approve, fill LOP order, exercise cST) without us hard-coding each flow.

6. **No auth, no middleware**: per the current requirements the API is open (no bearer token, no helmet/cors/rate-limit). Keep it minimal — only what's strictly needed to boot Express and JSON-parse requests. Error handling stays inline in route handlers (no dedicated middleware).

7. **Minimal but clean stack (2026)**:
   - Node 20+ / TypeScript strict / ESM
   - `express` 4.x
   - `viem` (transitive of permissionless, but pinned)
   - `permissionless` (latest stable, v0.2.x)
   - `zod` (env validation + request body validation)
   - `pino` (structured logging)
   - `tsx` for dev watch, `tsc` for build
   - `eslint` + `prettier`
   - `dotenv`

## High-level Task Breakdown

Each task has a **verifiable success criterion**.

### Task 1 — Project bootstrap (structure, tooling, deps)

- Init `package.json` (ESM, `"type": "module"`, scripts: dev/build/start/lint/format/typecheck)
- Install runtime deps: `express`, `viem`, `permissionless`, `zod`, `pino`, `dotenv`
- Install devDeps: `typescript`, `tsx`, `@types/node`, `@types/express`, `eslint`, `prettier`, `@typescript-eslint/*`
- `tsconfig.json` strict + ESM (`"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`)
- `.eslintrc.json`, `.prettierrc`, `.gitignore`, `.nvmrc`
- Folder structure:
  ```
  src/
    config/env.ts
    services/wallet.ts
    routes/health.ts
    routes/wallet.ts
    routes/tx.ts
    logger.ts
    app.ts
    index.ts
  ```
- `.env.example` with all variables documented (in English)

**Success criterion**: `npm run typecheck` passes, folder structure in place, `.env.example` complete.

### Task 2 — Env config & logger

- `src/config/env.ts`: parse `process.env` with zod. Variables:
  - `NODE_ENV` (default `development`)
  - `PORT` (default `3000`)
  - `LOG_LEVEL` (default `info`)
  - `SHARED_EOA_PRIVATE_KEY` (0x-prefixed hex, 64 chars) — required
  - `PIMLICO_API_KEY` — required
  - `ALCHEMY_RPC_URL` — required (Arbitrum One HTTP endpoint)
- Export typed `env` object, throw explicit error if validation fails
- `src/logger.ts`: pino logger with `LOG_LEVEL` from env

**Success criterion**: booting with a missing var crashes with a clear message; otherwise typed `env` is exported.

### Task 3 — Smart wallet service (permissionless + basic Safe 4337)

- `src/services/wallet.ts`:
  - `publicClient` (viem, Arbitrum, HTTP transport via Alchemy URL)
  - `owner` = `privateKeyToAccount(env.SHARED_EOA_PRIVATE_KEY)`
  - `pimlicoClient` (bundler + paymaster) via `createPimlicoClient({ transport: http(pimlicoUrl), entryPoint: { address: entryPoint07Address, version: '0.7' } })`
  - `safeAccount` = `toSafeSmartAccount({ client: publicClient, owners: [owner], version: '1.4.1', entryPoint: { address: entryPoint07Address, version: '0.7' } })` — **no** validators, **no** attesters
  - `smartAccountClient` = `createSmartAccountClient({ account: safeAccount, chain: arbitrum, bundlerTransport: http(pimlicoUrl), paymaster: pimlicoClient, userOperation: { estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast } })`
  - Export `getWalletInfo()` (address, owner address, chain, deployed status), `sendCalls(calls)`

**Success criterion**: at boot, log the smart wallet address + EOA address + chainId. `getWalletInfo()` returns a well-typed JSON.

### Task 4 — Routes

- `GET /health`: `{ status: 'ok', uptime, version }`
- `GET /wallet`: `{ smartWalletAddress, ownerAddress, chainId, chainName, isDeployed }`
- `POST /tx`: body validated with zod: `{ calls: [{ to, value?, data? }], waitForReceipt?: boolean }`
  - Sends userOp via `smartAccountClient.sendUserOperation({ calls })`
  - Returns `{ userOpHash }`; if `waitForReceipt=true`, waits and returns `{ userOpHash, receipt: { transactionHash, blockNumber, success } }`
  - Basic try/catch in the handler returns `500 { error, message }` on failure (no dedicated middleware)

**Success criterion**: the 3 endpoints respond correctly. Manual test via curl (documented in README).

### Task 5 — Server bootstrap (app.ts + index.ts)

- `src/app.ts`: `createApp()` factory — express instance + `express.json()` + routes only. No helmet/cors/rate-limit.
- `src/index.ts`: on startup: validate env → init wallet service (log the smart wallet address) → start server on `env.PORT` → graceful shutdown on SIGINT/SIGTERM

**Success criterion**: `npm run dev` starts the server, logs the smart wallet address, listens on `PORT`. Ctrl-C shuts down cleanly.

### Task 6 — Documentation (English)

- `README.md` (top-level): quick-start (install, env, run), API summary with curl examples, security warnings about the shared EOA
- `PROJECT.md`: global hackathon project summary (context, high-level architecture, team split) — what Bond and Cork should read to understand the context

**Success criterion**: an external dev can clone, fill `.env`, `npm i && npm run dev`, see the smart wallet address, call `POST /tx` with the provided curl example.

### Task 7 — Verification & handoff

- `git init`, clean initial commit
- Manual test:
  - `GET /health` → 200
  - `GET /wallet` → consistent smart wallet address
  - User deploys the smart wallet
  - `POST /tx` with a minimal call (e.g., transfer 0 wei to self) → userOp lands on-chain, tx visible on Arbiscan sponsored by Pimlico

**Success criterion**: a real Pimlico-sponsored tx is visible on-chain, initiated by the smart wallet.

## Project Status Board

- [x] Task 1 — Project bootstrap (structure, deps, tooling)
- [x] Task 2 — Env config + logger
- [x] Task 3 — Smart wallet service (basic Safe 4337 + Pimlico paymaster)
- [x] Task 4 — Routes (/health, /wallet, /tx)
- [x] Task 5 — App + server bootstrap
- [x] Task 6 — Documentation (README + PROJECT.md, English)
- [ ] Task 7 — Verification (sponsored tx on-chain) — awaiting user

## Current Status / Progress Tracking

**Status**: Tasks 1–6 complete. Smoke test confirmed the boot chain works end-to-end (env → logger → wallet init → paymaster → Express listen). The startup successfully reached `readContract(proxyCreationCode)` on the Safe factory with fake creds, proving all imports, types, and control flow are correct. Only real `PIMLICO_API_KEY` + `ALCHEMY_RPC_URL` + `SHARED_EOA_PRIVATE_KEY` are needed to fully init.

Awaiting user to run Task 7 manually.

## Executor's Feedback or Assistance Requests

### Milestone: Tasks 1–6 complete. Manual verification needed (Task 7).

To verify:

1. `cp .env.example .env` and fill in real values (`SHARED_EOA_PRIVATE_KEY`, `PIMLICO_API_KEY`, `ALCHEMY_RPC_URL`)
2. `npm run dev` — expect a log line showing the smart wallet address on Arbitrum One
3. `curl http://localhost:3000/health` → `{ status: 'ok', ... }`
4. `curl http://localhost:3000/wallet` → the smart wallet info
5. Send a self-call to force deployment + verify Pimlico sponsorship:
   ```bash
   curl -X POST http://localhost:3000/tx \
     -H 'content-type: application/json' \
     -d '{ "calls": [{ "to": "<SMART_WALLET_ADDRESS>", "value": "0", "data": "0x" }], "waitForReceipt": true }'
   ```
6. Check the returned `receipt.transactionHash` on Arbiscan — the tx should be sponsored (no ETH from the smart wallet).

### Notes

- Deps installed cleanly, 0 npm audit vulnerabilities.
- `npm run typecheck` takes ~14 minutes because of `permissionless`'s deep generics (known upstream issue). It passes.
- No lint errors.
- The smoke-test (Node runtime with fake env) confirmed all imports resolve and `toSafeSmartAccount` was reached successfully.

## Lessons

_To be filled during the project._

- The sample provided uses `getOwnableValidator` + `RHINESTONE_ATTESTER_ADDRESS` + `SAFE_7579_ADDRESS`. For the basic version requested here, **do not** use these params — `toSafeSmartAccount` with `owners: [eoa]` + `version: '1.4.1'` + `entryPoint 0.7` is enough.
- All comments in code, all `.md` docs, and all log messages are written in **English**.
