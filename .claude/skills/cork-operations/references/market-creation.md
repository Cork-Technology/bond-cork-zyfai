# Market creation — `CorkMarketCreator.createMarket`

<!-- Sources of truth: cork/docs/integration.md + cork/src/CorkMarketCreator.sol, cork/src/FixedRateOracleFactory.sol
     in this repo. Runnable reference: cork/docs/examples/market-rfq.mjs (create + opening bid). -->

Creation is permissionless — any address can call (the live `CorkMarketCreator` already holds
`POOL_CREATOR_ROLE` on the controller; no grant step). The wrapper deploys a `FixedRateOracle` for
your rate (CREATE2, one deploy per rate per factory) and creates the Cork pool through the
controller. Creating a market IS the request for quote in the ceremony: follow it with an
opening bid (`references/limit-orders.md`). Address: see `references/addresses.md`.

## The entry point

```solidity
struct CreateParams {
    address collateralAsset;      // CA
    address referenceAsset;       // REF
    uint256 expiryTimestamp;      // unix seconds, strictly in the future
    uint256 rate;                 // 1e18-scaled: value of 1 REF in CA (0.8e18 = 0.8 CA)
    uint256 rateMin;              // fixed-rate recipe: = rate
    uint256 rateMax;              // fixed-rate recipe: = rate + 1
    uint256 rateChangePerDayMax;  // fixed-rate recipe: 0
    uint256 rateChangeCapacityMax;// fixed-rate recipe: 0
    uint256 swapFeePercentage;    // 1e18 = 1%; max 5e18
    uint256 unwindSwapFeePercentage; // same scale and cap
    bool    isWhitelistEnabled;   // false — MUST be false for JIT orders
}
function createMarket(CreateParams calldata params) external;
```

## Parameter recipe (fixed rate — the confirmed recipe)

| Field | Value | Why |
|---|---|---|
| `rateMin` | `rate` | creation requires `rateMin > 0` AND strictly `rateMin < rateMax`; bootstrap requires `rateMin <= rate <= rateMax` |
| `rateMax` | `rate + 1n` | smallest value passing the strict check — never set `rateMin == rateMax` |
| `rateChangePerDayMax` | `0` | not validated by Cork; zero freezes all rate movement |
| `rateChangeCapacityMax` | `0` | same |
| fees | 1e18 = 1% | a 1% swap fee is `1000000000000000000`; getting the scale wrong by 100x is a real risk; max 5e18 each |
| `isWhitelistEnabled` | `false` | phoenix gates `mint` by the per-market whitelist and the JIT adapter is the `msg.sender` there — a whitelisted market makes every JIT fill revert |

Assets: different, nonzero, non-rebasing ERC-20s with at most 18 decimals, and both MUST
implement `name()` and `symbol()` (phoenix's SharesFactory calls them at creation; a token
without them reverts with no error data). Markets here are intended to be short-lived (about
24 hours), which is why a fixed oracle rate is acceptable.

## First-writer-wins on fees and whitelist

The market's identity (`marketId`) covers ONLY the `Market` struct fields (assets, expiry,
rate band, rate clamps, oracle address). Fees and `isWhitelistEnabled` are NOT part of
identity: whoever creates a given market FIRST fixes them. If your call lands second it
reverts at the oracle factory (rate already used) and the existing market carries the first
creator's configuration. Before relying on a market you did not observably create: read back
`CorkPoolManager.swapFee(marketId)` / `unwindSwapFee(marketId)` and check the whitelist flag.
Best defense: create early.

## Precompute before sending

Both the oracle address and the market id are deterministic:

- **Oracle**: call the view `FixedRateOracleFactory.computeAddress(rate)`. A repeat rate
  reverts with NO error data (CREATE2 salt collision) and the failed deploy still consumes
  the forwarded gas — so check `getCode` at `computeAddress(rate)` first; existing code means
  the rate is taken.
- **Market id**: keccak256 of the ABI-encoded `Market` struct — field order is load-bearing:

```ts
const marketId = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
   { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }],
  [collateralAsset, referenceAsset, expiryTimestamp, rateMin,   // rateMin = rate
   rateMax, 0n, 0n, oracleAddress],                             // rateMax = rate + 1n
));
```

## Recipe: simulate → send → parse the event

```ts
import { createWalletClient, http, parseAbi, parseEventLogs, parseUnits, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const CREATOR_ABI = parseAbi([
  "struct CreateParams { address collateralAsset; address referenceAsset; uint256 expiryTimestamp; uint256 rate; uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; uint256 swapFeePercentage; uint256 unwindSwapFeePercentage; bool isWhitelistEnabled; }",
  "function createMarket(CreateParams params)",
  "event MarketCreated(bytes32 indexed id, address oracle, address collateralAsset, address referenceAsset, uint256 expiryTimestamp, uint256 rate)",
]);

const client = createWalletClient({
  account: privateKeyToAccount(PRIVATE_KEY), chain: arbitrum, transport: http(RPC_URL),
}).extend(publicActions);

const rate = parseUnits("0.8", 18);
const nowSeconds = Number((await client.getBlock()).timestamp); // chain time, not wall time
const params = {
  collateralAsset: CA, referenceAsset: REF,
  expiryTimestamp: BigInt(nowSeconds + 86400),
  rate, rateMin: rate, rateMax: rate + 1n,
  rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n,
  swapFeePercentage: parseUnits("1", 18),        // 1%
  unwindSwapFeePercentage: parseUnits("2", 18),  // 2%
  isWhitelistEnabled: false,
};

// Simulate first: invalid parameters fail with a deep Cork error selector that is hard to
// read out of a reverted transaction; the simulation surfaces it before you spend gas.
const { request } = await client.simulateContract({
  address: MARKET_CREATOR, abi: CREATOR_ABI, functionName: "createMarket", args: [params],
});
const receipt = await client.waitForTransactionReceipt({ hash: await client.writeContract(request) });
const [created] = parseEventLogs({ abi: CREATOR_ABI, eventName: "MarketCreated", logs: receipt.logs });
const poolId = created.args.id;   // this is the MarketId every other call takes
```

Runnable end-to-end version (creation + the ceremony's opening bid in one script):
`cork/docs/examples/market-rfq.mjs`.

## Revert catalog

| Revert | Meaning / fix |
|---|---|
| no error data | TWO distinct causes. (a) Rate already used through this factory (CREATE2 collision) — someone else created the market and fixed its fees/whitelist; check `computeAddress(rate)` for code first. (b) An asset that does not implement `symbol()`/`name()` — phoenix's SharesFactory staticcalls them during pool creation. If `computeAddress(rate)` has no code, it is (b): diagnose with `cast call --trace` and fix the token. |
| `AlreadyInitialized()` | market already exists (created through a different pool creator) |
| `InvalidExpiry()` | `expiryTimestamp` not strictly in the future — use chain time, not wall time |
| `InvalidRate()` | `rate == 0` (oracle constructor), or oracle rate outside `[rateMin, rateMax]` at bootstrap (same selector) |
| `rateMin == 0` or `rateMin >= rateMax` | recipe violated — `rateMin = rate`, `rateMax = rate + 1` |
| fee above `5e18` | fee scale wrong — 1e18 is 1%, not 100% |
| zero/equal asset addresses, or a token with more than 18 decimals | pick valid assets |
| `AccessControl...` revert at the controller | the creator was never granted `POOL_CREATOR_ROLE` — possible only on a local throwaway stack (the live creator already holds the role); see the fork-testing recipe in `references/addresses.md` |

Anything else is a Cork protocol error bubbling up from pool creation — prefer catching it in
the simulation.
