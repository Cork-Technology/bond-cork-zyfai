# bond.credit × Cork × Zyfai

Monorepo for the agentic risk-trading pilot at Arbitrum Open House London. Two
autonomous agents discover the price of a risk slice and settle it on-chain through
Cork. For the full pilot context — goal, team split, architecture — see
[`PROJECT.md`](./PROJECT.md).

## Layout

One folder per part. The two agents are independent; both integrate Cork.

```
zyfai/    Trading (demand) agent — buys cST coverage. The TypeScript / Node
          Express server: an ERC-4337 Safe smart wallet on Arbitrum One,
          Pimlico-sponsored, with a generic tx API. Runnable today.

bond/     Underwriting (supply) agent — prices and underwrites the risk, holds
          cPT. Placeholder, to be built by Bond.

cork/     Cork integration both agents build on — Solidity / Foundry:
          CorkMarketCreator, CorkLimitOrderAdapter (just-in-time minting on
          1inch Limit Order Protocol v4), the fixed-rate oracle, and the
          off-chain ceremony examples under cork/docs/examples/.

.claude/skills/cork-operations/   Shared agent playbook for operating Cork
          (market creation, pool actions, the cST coverage ceremony). Root-level
          so a Claude agent in this repo discovers it automatically.
```

## Working in each folder

- **`zyfai/`** — `cd zyfai && npm install && npm run dev`. See [`zyfai/README.md`](./zyfai/README.md).
- **`cork/`** — `cd cork && forge build && forge test`. Needs submodules: after
  clone run `git submodule update --init --recursive` (fetches `forge-std` and the
  public `phoenix` protocol repo under `cork/lib/`). See [`cork/README.md`](./cork/README.md).
- **`bond/`** — not built yet; see [`bond/README.md`](./bond/README.md).

The parts share no build: Node tooling governs `zyfai/`, Foundry governs `cork/`.
