# CLAUDE.md

## What this repo is

A two-part monorepo for the `bond.credit × Cork × Zyfai` hackathon pilot (Arbitrum
Open House London). It holds the Zyfai agent server and the Cork on-chain integration
side by side.

For the pilot's goal, team split, and architecture, read [`PROJECT.md`](./PROJECT.md)
first.

## Layout

```
/ (repo root)      Zyfai agent server — TypeScript / Node / Express.
                   ERC-4337 Safe smart wallet on Arbitrum One, Pimlico-sponsored.
                   Exposes GET /wallet, POST /tx, GET /health. See README.md.

contracts/         Cork market-creation + 1inch Limit Order Protocol (LOP) v4 integration
                   — Solidity / Foundry. Its own Foundry root, README, and CLAUDE.md.
                   Build/test with `forge` from inside contracts/.

.claude/skills/    cork-operations — the agent playbook for operating Cork Phoenix.
                   Root-level, so a Claude agent in this repo discovers it automatically.
```

The two parts have separate toolchains and never share a build. Node tooling
(`package.json`, `tsconfig`) governs the root; Foundry (`foundry.toml`,
`remappings.txt`, `lib/` submodules) governs `contracts/`.

## Working in `contracts/`

- `cd contracts && forge build && forge test` — needs submodules: after clone run
  `git submodule update --init --recursive` (pulls `forge-std` and the public
  `phoenix` protocol repo, which has its own nested dependencies).
- `contracts/CLAUDE.md` carries the full contract-level knowledge graph.

## Operating Cork autonomously

The agent-facing playbook is the root-level skill
[`.claude/skills/cork-operations/`](./.claude/skills/cork-operations/) — discoverable as
the `cork-operations` skill from this repo root. It carries the decision rules to create
markets, run pool actions, and trade cST coverage through the ceremony (just-in-time
orders on 1inch LOP v4). Its `references/` hold the live Arbitrum One address book and
the Cork Phoenix API guide, and it points at the runnable off-chain examples under
`contracts/docs/examples/`.
