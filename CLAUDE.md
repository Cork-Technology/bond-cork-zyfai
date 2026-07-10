# CLAUDE.md

## What this repo is

A monorepo for the `bond.credit × Cork × Zyfai` hackathon pilot (Arbitrum Open House
London). Two autonomous agents — a trading agent and an underwriting agent — discover
the price of a risk slice and settle it on-chain through Cork. Read
[`PROJECT.md`](./PROJECT.md) first for the goal, team split, and architecture.

## Layout

One folder per part. The two agents are independent; both integrate Cork.

```
zyfai/    Trading (demand) agent — buys cST coverage. TypeScript / Node / Express:
          an ERC-4337 Safe smart wallet on Arbitrum One, Pimlico-sponsored, with a
          generic tx API (GET /wallet, POST /tx, GET /health). See zyfai/README.md.

bond/     Underwriting (supply) agent — prices/underwrites the risk, holds cPT.
          Placeholder, to be built by Bond. See bond/README.md.

cork/     Cork integration both agents build on — Solidity / Foundry. Its own
          Foundry root, README, and CLAUDE.md (cork/CLAUDE.md carries the full
          contract-level knowledge graph). Build with `forge` from inside cork/.

.claude/skills/cork-operations/   Shared, root-level agent playbook for operating
          Cork. Auto-discovered as the cork-operations skill.
```

Each part has its own toolchain and they never share a build. Node tooling governs
`zyfai/`; Foundry (`foundry.toml`, `remappings.txt`, `lib/` submodules) governs
`cork/`.

## Working in `cork/`

- `cd cork && forge build && forge test` — needs submodules: after clone run
  `git submodule update --init --recursive` (pulls `forge-std` and the public
  `phoenix` protocol repo, which has its own nested dependencies).
- `cork/CLAUDE.md` carries the full contract-level knowledge graph.

## Operating Cork autonomously

Both agents operate Cork through the root-level skill
[`.claude/skills/cork-operations/`](./.claude/skills/cork-operations/) — discoverable
as the `cork-operations` skill. It carries the decision rules to create markets, run
pool actions, and trade cST coverage through the ceremony (just-in-time orders on
1inch LOP v4). Its `references/` hold the live Arbitrum One address book and the Cork
Phoenix API guide, and it points at the runnable off-chain examples under
`cork/docs/examples/`.
