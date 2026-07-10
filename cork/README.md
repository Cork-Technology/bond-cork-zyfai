# Cork Market Creator (Hackathon)

Permissionless creation of Cork markets on the shadow Phoenix deployment (Arbitrum One), built for the Bond.credit / Zyf.ai hackathon.

Four contracts:

- **`FixedRateOracle`** — a rate oracle whose rate is fixed forever at deployment. Implements Cork's `IRateOracle` (`rate()` returns 1 Reference Asset quoted in Collateral Asset, scaled by 1e18). Intended for short-lived (~24 hour) markets.
- **`FixedRateOracleFactory`** — deterministic factory (CREATE2, keyed by rate). `deploy(rate)` deploys the oracle for a rate — once; a repeat deploy for the same rate reverts on the CREATE2 salt collision. `computeAddress(rate)` lets you precompute the address off-chain.
- **`CorkMarketCreator`** — the single permissionless entry point, `createMarket(CreateParams)`. Deploys the oracle, then creates the pool through `DefaultCorkController.createNewPool`. A repeat call with an already-used rate reverts at the factory (before Cork is reached); all other validation is Cork's own and bubbles up unchanged. The wrapper holds `POOL_CREATOR_ROLE` on the controller; the wrapper itself restricts nobody.
- **`CorkLimitOrderAdapter`** — the single 1inch LOP v4 adapter for coverage orders: just-in-time minting in one stateless contract. As `IPreInteraction` (maker selling cST it doesn't hold yet; committed in the signed extension) and `ITakerInteraction` (taker lifting a buy-cST bid; chosen per fill, no maker cooperation) it pulls collateral only from the party being served, mints both legs to that party via `IPoolManager.mint`, and holds nothing across transactions. Requires markets created with the whitelist DISABLED (phoenix gates `mint` by whitelist, and `msg.sender` there is the adapter).

No dependency on the private `phoenix-private` repo — all Cork types are vendored as minimal interfaces under `src/interfaces/` (pinned to phoenix commit `0c22c5d3`, v1.1.2). 1inch types (`Order`, callback + getter interfaces) are vendored the same way in `src/interfaces/I1inchLimitOrderProtocol.sol` (pinned to LOP v4 master, the code live at the canonical `0x111111125421cA6dc452d289314280a0f8842A65` on mainnet and Arbitrum One).

## Docs

- Integration guide for agent developers: [`docs/integration.md`](docs/integration.md)
- Design spec: [`docs/superpowers/specs/2026-07-09-lop-market-creator-design.md`](docs/superpowers/specs/2026-07-09-lop-market-creator-design.md)

## Develop

```bash
forge build
forge test                      # unit tests (mocked controller/pool manager)
# fork tests (skipped unless configured):
ARBITRUM_RPC_URL=... CONTROLLER=0x... POOL_MANAGER=0x... ADMIN=0x... forge test --match-path 'test/fork/*'
```

## Deploy

```bash
CONTROLLER=0x... POOL_MANAGER=0x... LOP=0x111111125421cA6dc452d289314280a0f8842A65 \
  forge script script/Deploy.s.sol --rpc-url $ARBITRUM_RPC_URL --broadcast
```

The script prints the `grantRole(POOL_CREATOR_ROLE, <creator>)` call the admin must make on the controller. The hook needs no wiring: it is a stateless/permissionless adapter referenced from order extensions and fill args.
