# Creating Cork Markets — Integration Guide for Agent Developers

This guide is for anyone (in particular Bond's agent developers) who wants to create Cork markets programmatically. It is self-contained: you do not need access to the Cork protocol source code.

## What this system does

Cork markets on the shadow Phoenix deployment (Arbitrum One) are created permissionlessly through a thin wrapper contract, `CorkMarketCreator`. You call one function, `createMarket`, with your market parameters. The wrapper:

1. Deploys a `FixedRateOracle` for your rate. The oracle's rate is fixed forever at deployment. **Each rate can be used only once per factory**: a repeat call with an already-used rate reverts at the factory (a CREATE2 salt collision, which carries no error data).
2. Creates the Cork pool. On success it emits `MarketCreated`.

The wrapper performs no validation of its own beyond that one-deploy-per-rate constraint: every other creation-time check is Cork's, and Cork's revert bubbles up to you unchanged.

There is no caller restriction — any address (a contract or a regular account) can call `createMarket`. The wrapper holds the pool-creation role on the Cork controller; you do not need any role.

## Deployed addresses (Arbitrum One, shadow Phoenix deployment)

| Contract | Address |
|---|---|
| `CorkMarketCreator` | _to be filled in after deployment_ |
| `FixedRateOracleFactory` | _to be filled in after deployment_ |
| `DefaultCorkController` (Cork) | _to be filled in after deployment_ |
| `CorkPoolManager` (Cork) | _to be filled in after deployment_ |

## The entry point

```solidity
struct CreateParams {
    address collateralAsset;
    address referenceAsset;
    uint256 expiryTimestamp;
    uint256 rate;
    uint256 rateMin;
    uint256 rateMax;
    uint256 rateChangePerDayMax;
    uint256 rateChangeCapacityMax;
    uint256 swapFeePercentage;
    uint256 unwindSwapFeePercentage;
    bool    isWhitelistEnabled;
}

function createMarket(CreateParams calldata params) external;
```

## Choosing parameters

### Assets

- `collateralAsset` and `referenceAsset` are the two ERC-20 tokens of the market. They must be different, nonzero addresses.
- Both tokens must be **non-rebasing** and have **at most 18 decimals** (Cork enforces the decimals bound at creation; there is no lower bound).

### Expiry

- `expiryTimestamp` is a unix timestamp in seconds. It must be strictly in the future when the market is created; Cork reverts with `InvalidExpiry()` otherwise.
- Markets in this setup are intended to be short-lived — on the order of 24 hours — which is why a fixed oracle rate is acceptable.

### Rate and the fixed-rate recipe

`rate` is the value of **1 Reference Asset quoted in Collateral Asset, scaled by 1e18**. A rate of `0.8e18` means 1 REF is worth 0.8 CA. A zero rate reverts with `InvalidRate()`.

The rate-band and rate-change fields exist for markets with live oracles. For a fixed-rate market, use this confirmed recipe:

| Field | Value | Why |
|---|---|---|
| `rateMin` | `rate` | Creation requires `rateMin > 0` and strictly `rateMin < rateMax`. Bootstrap requires `rateMin <= rate <= rateMax`. |
| `rateMax` | `rate + 1` | The smallest value that passes the strict `rateMin < rateMax` check. |
| `rateChangePerDayMax` | `0` | Not validated by Cork; zero freezes all rate movement. |
| `rateChangeCapacityMax` | `0` | Same. |

With a fixed oracle, the rate the protocol uses equals the oracle rate for the market's entire life — the constraint adapter short-circuits when the rate never changes.

Do **not** set `rateMin = rateMax = rate`: Cork requires `rateMin` to be strictly below `rateMax` and rejects that at creation.

### Fees

- `swapFeePercentage` and `unwindSwapFeePercentage` are 1e18-scaled **percentages**: `1e18` means 1%, not 100%. The maximum for each is `5e18` (5%), enforced at creation.
- Getting this scale wrong by 100x is a real risk. Double-check: a 1% swap fee is `1000000000000000000`.

### Whitelist

- `isWhitelistEnabled` controls whether the pool restricts participants. Use `false` unless you have a specific reason.

## What can revert a creation

The wrapper passes parameters through; Cork's own validation reverts and the revert bubbles up to you. The full list of creation-time rejections:

- the rate was already used through this factory (CREATE2 salt collision at the oracle factory — the revert carries **no error data**)
- either asset address is zero, or the two assets are equal
- either token has more than 18 decimals
- `expiryTimestamp` not strictly in the future (`InvalidExpiry()`; Cork checks this before the already-exists check)
- `rateMin == 0`, or `rateMin >= rateMax` (strict `<` required)
- oracle rate outside `[rateMin, rateMax]` (checked at bootstrap, which runs inside creation)
- either fee above `5e18` (5%)
- `rate == 0` (oracle constructor, `InvalidRate()`)

## Precomputing everything off-chain

Both the oracle address and the market id are deterministic — you can compute them before sending any transaction.

**Oracle address.** Either call `FixedRateOracleFactory.computeAddress(rate)` (a view function), or compute the CREATE2 address yourself:

```
salt          = bytes32(rate)
initCodeHash  = keccak256(FixedRateOracle.creationCode ++ abi.encode(rate))
oracle        = address(keccak256(0xff ++ factoryAddress ++ salt ++ initCodeHash)[12:])
```

**Market id.** The id is the hash of the ABI-encoded `Market` struct, with fields in exactly this order:

```
Market {
    address collateralAsset;
    address referenceAsset;
    uint256 expiryTimestamp;
    uint256 rateMin;
    uint256 rateMax;
    uint256 rateChangePerDayMax;
    uint256 rateChangeCapacityMax;
    address rateOracle;     // the precomputed oracle address
}
marketId = keccak256(abi.encode(market))
```

Example with viem:

```ts
const marketId = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
   { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }],
  [collateralAsset, referenceAsset, expiryTimestamp, rateMin,
   rateMax, 0n, 0n, oracleAddress],
));
```

## Recommended flow

1. **Build your `CreateParams`** using the recipe above. Precompute the oracle address and market id.
2. **Simulate before sending.** Run an `eth_call` against `createMarket(params)` as a read-only simulation. Invalid parameters fail with a deep Cork error selector that is hard to read from a reverted transaction; the simulation surfaces the failure before you spend gas.
3. **Send the transaction.** On success, `MarketCreated(id, oracle, collateralAsset, referenceAsset, expiryTimestamp, rate)` fires — you created the market. If someone else used the same rate first, your transaction reverts at the oracle factory with no error data. See the warning below.
4. **If your call reverted that way, verify the existing market's configuration** before using it (see next section).

## Warning: fees and whitelist are first-writer-wins

The market's identity (`marketId`) covers **only** the `Market` struct fields: the assets, the expiry, the rate band, the rate-change clamps, and the oracle address. The fees (`swapFeePercentage`, `unwindSwapFeePercentage`) and `isWhitelistEnabled` are **not** part of identity.

Consequence: whoever creates a given market **first** fixes its fees and whitelist setting. If your call lands second — a race with another agent, or a deliberate front-run — your transaction reverts (at the oracle factory, since the rate was already used), and the existing market carries the first creator's configuration, not yours.

Before relying on a market you did not observably create yourself:

- read the stored fees back (`CorkPoolManager.swapFee(marketId)` and `CorkPoolManager.unwindSwapFee(marketId)`) and compare them with what you intended;
- check the whitelist setting if it matters to you.

The best defense is to **create early**: send your creation transaction as soon as your parameters are final, so you are the first writer.

## Gas

Creation pays for (a) the oracle deployment, (b) the pool creation, and (c) the oracle bootstrap. A repeat call with an already-used rate reverts at the oracle factory; note that a CREATE2 collision consumes the gas forwarded to the deployment, so a failed repeat is not cheap.

## Events reference

```solidity
event MarketCreated(
    MarketId indexed id,
    address oracle,
    address collateralAsset,
    address referenceAsset,
    uint256 expiryTimestamp,
    uint256 rate
);
```

## Errors reference

| Error | Meaning |
|---|---|
| revert with **no error data** | The rate was already used through this factory (CREATE2 salt collision at the oracle deployment). Whoever used it first created the market and fixed its fees and whitelist setting — verify before using it. |
| `AlreadyInitialized()` | The market already exists (Cork). Through this wrapper you will normally hit the no-error-data factory revert first; this error can still surface if the same market was created through a different pool creator. |
| `InvalidExpiry()` | `expiryTimestamp` was not strictly in the future (Cork). |
| `InvalidRate()` | `rate` was zero (raised by the oracle constructor). Also raised by Cork itself if the oracle rate falls outside `[rateMin, rateMax]` at bootstrap — the two errors share the same selector. |
| `ZeroAddress()` | Constructor wiring error (deployment-time only, not something callers see). |

Anything else is a Cork protocol error bubbling up from pool creation — consult the validation list above, and prefer catching problems in the `eth_call` simulation.

---

# Trading cST Coverage — the order layer (CorkLimitOrderAdapter)

Market creation is half the ceremony. The other half is the negotiation on the 1inch Limit
Order Protocol (LOP v4, canonical `0x111111125421cA6dc452d289314280a0f8842A65` on Arbitrum
One): the asker creates the market (that IS the request for quote), posts a signed BID for
coverage, the underwriter counters with an ASK or lifts the bid, and the fill settles
atomically. One stateless contract — `CorkLimitOrderAdapter` — makes resting orders viable
with one job: just-in-time minting.

## The JIT mint hook — capital appears at the fill

Lets the underwriter sell or deliver cST it does not hold yet; collateral leaves its wallet
only when a fill actually happens. `extraData = abi.encode(MarketId)` in both roles:

- **As maker (ASK)**: put the hook in the signed extension's pre-interaction slot
  (`abi.encodePacked(adapterAddress, abi.encode(poolId))`) and set the maker traits
  `PRE_INTERACTION_CALL_FLAG`. The hook fires BEFORE the LOP pulls the cST. Remember the LOP
  commits the extension via the order salt: `salt`'s low 160 bits must be the extension hash
  or fills revert `InvalidExtension`.
- **As taker (lifting a BID)**: pass the hook as the fill's `interaction` argument —
  `abi.encodePacked(adapterAddress, abi.encode(poolId))`. No maker cooperation needed. The hook
  fires after the premium arrives, before the LOP pulls the cST from you.

In both roles the hook pulls `previewMint(poolId, cstAmount)` of CA from the party being
served, mints cST + cPT to that party via `IPoolManager.mint`, and holds nothing after the
transaction. The cPT (underwriter leg) stays with you; the LOP moves only the cST.

## Approval matrix (one-time setup per party)

| Party | Approval | When |
|---|---|---|
| Underwriter | CA -> `CorkLimitOrderAdapter` | once per CA token |
| Underwriter | cST -> LOP | once per market (cron, at pricing time) |
| Asker | CA -> LOP | once per CA token (pays premium on fills) |

## Hard requirements

- Markets MUST be created with `isWhitelistEnabled = false` — phoenix gates `mint` by the
  per-market whitelist and the hook is the `msg.sender` there. A whitelisted market makes
  every JIT fill revert.
- Orders die at market expiry because the mint reverts (`MintUnavailable`), but set a 1inch
  order expiry as a backstop anyway.
- Cancelling an order costs gas (`cancelOrder` on the LOP). That is a feature: counter-offers
  are cheap, flip-flopping is not.
