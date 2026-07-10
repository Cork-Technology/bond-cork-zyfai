# Coverage orders — the ceremony, JIT-first

<!-- Sources of truth: docs/examples/ — ceremony.md (flow + account-type rule),
     contract-maker.md (contract makers, real-Safe note), lib.mjs (ALL byte plumbing:
     extension encoding, salt commitment, maker/taker traits, orderExpiry/expiryOf, EIP-712 +
     compact signatures, KNOWN_ERRORS_ABI), the order-shape scripts named per section, and
     src/CorkLimitOrderAdapter.sol for hook semantics. The examples are fork-proven against
     the REAL 1inch protocol and the REAL CorkPoolManager — trust them over any restatement. -->

Orders rest on the 1inch Limit Order Protocol v4 (address: `references/addresses.md`); the
Cork API is the book. **Never re-derive byte plumbing** — import from `docs/examples/lib.mjs`
(`buildExtension`, `saltForExtension`, `packTargetAndData`, `buildMakerTraits`,
`buildTakerTraits`, `orderExpiry`, `orderTypedData`, `toCompactSignature`, the fill ABIs, and
`KNOWN_ERRORS_ABI` + `failWith` for decoded reverts). Run scripts from `docs/examples/`
(node 20+, `npm i viem` there first — this creates `package.json`/`node_modules` in that
directory; delete them when done if the repo must stay clean). Point `STATE_FILE`/`ORDER_FILE`
at a scratch directory outside the repo, or the default handoff JSON lands next to the
scripts.

## The ceremony

Market creation IS the request for quote. The five moves:

1. **Create** — the asker (wants cover) creates the market with the whitelist OFF
   (`references/market-creation.md`). Costly, therefore credible.
2. **Bid** — the asker posts an opening BUY bid: `makerAsset = CA` (premium offered),
   `takerAsset = cST` (size wanted). **Deliberately plain-shaped — no extension.** Taker-side
   JIT is the lifter's own UNSIGNED choice attached as fill `args`; the bidder signs nothing
   about it. Script for steps 1+2 in one go: `docs/examples/market-rfq.mjs`.
3. **Discover** — the underwriter polls the book (or the file handoff) for new markets and
   resting bids, and prices them: bid at/above floor → take; below → counter.
4. **Counter** — the underwriter posts a NEW SELL ask at its price with the adapter committed
   in the SIGNED extension (maker-side JIT: it will owe cST at fill). Nothing is cancelled.
5. **Fill** — whoever moves first ends the negotiation: the asker fills the ask
   (`docs/examples/jit-fill.mjs`), or the underwriter lifts the bid
   (`docs/examples/lift-bid.mjs`).

The whole loop — both discovery modes, both account types — is one runnable script:
**`docs/examples/ceremony-e2e.mjs`**; prose walkthrough: `docs/examples/ceremony.md`.

Two JIT recipes — do not merge them:

| Leg | Who commits | Where the adapter rides |
|---|---|---|
| Opening bid, lifted | the LIFTER (taker), unsigned, per fill | fill `args` interaction = `packTargetAndData(ADAPTER, poolId)` (`lift-bid.mjs`) |
| Counter-ask, filled | the MAKER, signed once | extension pre-interaction slot; salt commits to it (`jit-order.mjs`) |

Either path ends the same: asker holds cST cover (premium paid); underwriter holds cPT + the
premium; the market holds the locked collateral until expiry.

## Adapter extension recipe (primary path — maker-side JIT ask)

Exact bytes: `docs/examples/jit-order.mjs` (maker) / `jit-fill.mjs` (taker) /
`lift-bid.mjs` (taker-side JIT). The shape, so you can recognize it:

- extension pre-interaction slot = adapter address ++ `abi.encode(poolId)` — build with
  `buildExtension({ preInteractionData: packTargetAndData(ADAPTER, poolId) })`;
- salt = `saltForExtension(extension)` — the salt's low 160 bits MUST commit to
  `keccak256(extension)` or every fill reverts `InvalidExtensionHash`;
- maker traits flags: HAS_EXTENSION (bit 249) + PRE_INTERACTION (bit 252) — pass
  `hasExtension: true, preInteraction: true` to `buildMakerTraits`;
- the taker passes the order's extension bytes VERBATIM in the fill `args`
  (`buildTakerTraits({ extensionHex: order.extension })`).

Inside one atomic fill: premium moves → adapter pulls `previewMint(poolId, cstAmount)` of CA
from the party being served and mints cST + cPT to them → the protocol moves the fresh cST.
The served party keeps the cPT. The adapter is stateless and custody-free; abuse can only
spend the abuser's own allowance.

Approval matrix (one-time; classic `approve` only — **never Permit2 for makers**):

| Party | Approval | When |
|---|---|---|
| Underwriter | CA -> `CorkLimitOrderAdapter` | once per CA token |
| Underwriter | cST -> 1inch protocol | once per market |
| Asker | CA -> 1inch protocol | once per CA token |

Sizing rule: approve the sum of remaining open-order amounts plus the new order's amount.
Management cap: at most 5 active orders per maker per pool.

## Account-type matrix (`makerAccountType` decides both columns)

| Maker | Verification | Fill function | Signature travels as |
|---|---|---|---|
| `EOA` | ECDSA recovery: signer == maker | `fillOrderArgs` | two bytes32 words — EIP-2098 compact split via `toCompactSignature` |
| `CONTRACT` | ERC-1271 `isValidSignature(hash, sig)` == `0x1626ba7e` | `fillContractOrderArgs` | raw 65-byte `r ++ s ++ v` |

Takers: read `makerAccountType` off the book and branch — never assume. The wrong variant
reverts `BadSignature`. Both fill ABIs are exported by `lib.mjs`. A contract maker's OWNER
signs the raw EIP-712 order hash (`owner.sign({ hash: orderHash })`); a real Safe differs — it
wraps the hash in its own SafeMessage envelope first and approvals go through
`execTransaction` — see `docs/examples/contract-maker.md`. Scripts:
`docs/examples/contract-order.mjs` (maker; `VARIANT=PLAIN|JIT`) / `contract-fill.mjs` (taker).
Fork proof: `test/fork/ContractMakerFill.fork.t.sol`.

## Negotiation: new orders, never cancels

A counter-offer is a NEW order posted via the API at the adjusted premium — nothing is
cancelled on-chain; after a counter BOTH orders rest and either side picks which to fill.
Consequence: **a superseded order stays fillable until it expires**, so EVERY bid/ask in a
negotiation MUST set an expiry in its maker traits — `orderExpiry(lifetimeSeconds)` from
`lib.mjs` (it lives in bits 80–119 of makerTraits; decode with `expiryOf`; the protocol
reverts `OrderExpired` past it; setting it is free). Keep negotiation orders short-lived
(minutes) so a stale price cannot be picked off. An on-chain `cancelOrder` exists for
emergencies only — it costs gas and is not part of the flow (that cost is the anti-flip-flop
incentive). Convergence policy: asker fills the best ask at/under its ceiling, else improves
its bid one notch; underwriter fills any bid at/above its floor, else posts its ask at
floor + margin.

## The order struct and Cork's bit conventions

The 8-field 1inch v4 order (all built for you by the example scripts):
`{ salt, maker, receiver, makerAsset, takerAsset, makingAmount, takingAmount, makerTraits }`.
Price is static: `takingAmount / makingAmount` IS the price forever; partial fills pay
pro-rata. Cork conventions on `buildMakerTraits`:

- `allowPartialFills` and `allowMultipleFills` must be EQUAL (both true is the default; the
  API rejects mixed settings);
- `nonce` goes in bits 120–159 (pass it to `buildMakerTraits({ nonce })`);
- expiry mandatory on negotiation orders (previous section);
- never `usePermit2`.

## Signing and the hash cross-check

Sign EIP-712 typed data via viem: `signTypedData(orderTypedData(chainId, order))` — the
domain in `lib.mjs` is the DEPLOYED one (name "1inch Aggregation Router", version "6" — the
limit-order protocol v4 ships inside Aggregation Router v6; do not substitute a
"Limit Order Protocol"/"4" domain, it produces the wrong hash). Always cross-check your
computed hash against the chain before posting:

The deployed order struct's address fields are user-defined value types over `uint256`, so
`hashOrder`'s real selector takes an ALL-`uint256` tuple — an `address`-typed ABI reverts
with empty data. Convert the address fields with `hexToBigInt`:

```ts
const orderHash = hashTypedData(orderTypedData(chainId, order));
const onchain = await client.readContract({
  address: LOP_ADDRESS,
  abi: parseAbi(["function hashOrder((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order) view returns (bytes32)"]),
  functionName: "hashOrder", args: [[order.salt, hexToBigInt(order.maker), hexToBigInt(order.receiver),
    hexToBigInt(order.makerAsset), hexToBigInt(order.takerAsset),
    order.makingAmount, order.takingAmount, order.makerTraits]],
});
if (orderHash !== onchain) throw new Error("EIP-712 hash mismatch — do not post");
```

## Submission — `POST /v1/limit-orders`

Full payload = the 8 order fields as strings + `orderHash`, `signature`, and Cork metadata:
`makerAccountType` (`"EOA"|"CONTRACT"`), `makerPermit2: ""`, `extension` (hex, or `""` for
plain), `side` (`"BUY"|"SELL"` — BUY offers CA for cST, SELL offers cST for CA), `premium`
(number, basis points 0–10000, display only), `expiry` (unix seconds, mirrors the traits),
`nonce` (string), `allowsPartialFills` (boolean), `chainId`. A 201 returns `{orderHash}` and
the order rests; a 400 "commitment mismatch" means the salt does not commit to the extension
— a POST-time save from a guaranteed on-chain `InvalidExtensionHash`. Exact payload
construction: `orderPayload()` in `docs/examples/ceremony-e2e.mjs`.

Trust rule: the orderbook is discovery only — before filling, verify on-chain: maker CA/cST
balance and allowances, order not expired (`expiryOf(makerTraits)`), and remaining fillability
(simulate the fill; `InvalidatedOrder` means already filled/cancelled).

## Environment-variable conventions (script vintages differ — do not mix)

Against the live stack, set the book URL (`ORDERBOOK_URL` / `CORK_API_URL`) to
`https://api-phoenix.cork.tech`.

| Script | Book URL | File handoff | Other |
|---|---|---|---|
| `ceremony-e2e.mjs` | `CORK_API_URL` | `STATE_FILE` (default `./ceremony-orders.json`) | `ASKER_PK`/`UNDERWRITER_PK`, `ASKER_ACCOUNT`/`UNDERWRITER_ACCOUNT` = `EOA|CONTRACT`, `MARKET_CREATOR`, `ADAPTER`, `CA`, `REF`, `CA_DECIMALS`, `RATE`, `SIZE_CST` |
| `market-rfq.mjs` | `ORDERBOOK_URL` | `ORDER_FILE` (default `./market-rfq-bid.json`) | `PRIVATE_KEY`, `MARKET_CREATOR`, `CA`, `REF`, `RATE`, `PRICE_CA_PER_CST` |
| `contract-order.mjs` / `contract-fill.mjs` | `ORDERBOOK_URL` | `ORDER_FILE` (default `./contract-order.json`) | `VARIANT=PLAIN\|JIT` (order side), `WALLET` to reuse a deployed wallet; run `forge build` first (deploys the ERC-1271 wallet artifact) |
| `plain-order.mjs` / `plain-fill.mjs` / `jit-order.mjs` / `jit-fill.mjs` / `lift-bid.mjs` | `ORDERBOOK_URL` | — (book only) | `SIDE=SELL\|BUY` (plain-order), `POOL_ID`, `ADAPTER` (JIT), `AMOUNT` (fills) |

`ceremony-e2e.mjs` discovery is parameterized: `CORK_API_URL` set → orders flow through the
API, and set-but-unreachable is a HARD error (never a silent fallback); unset → payloads pass
through `STATE_FILE` — the bare-fork mode (a local fork's state is invisible to the live API).

## Adapter revert catalog

All four are in `KNOWN_ERRORS_ABI` in `lib.mjs`; `failWith` decodes them (alongside the 1inch
errors: `BadSignature`, `OrderExpired`, `InvalidatedOrder`, `TakingAmountTooHigh`,
`InvalidExtensionHash`, ...).

| Adapter revert | Cause |
|---|---|
| `OnlyLimitOrderProtocol` | the interaction callback was called by something other than the 1inch protocol |
| `OrderNotForPool` | neither order side is the pool's cST — the extension's pool id does not match the order |
| `MintUnavailable` | the pool cannot mint: `previewMint` returned 0 (market whitelisted, paused, or expired — create markets with the whitelist OFF) |
| `MintAmountDrift` | `mint` spent a different collateral amount than `previewMint` quoted in the same transaction (guards the exact-allowance and no-custody invariants; should be unreachable) |

## Plain-order fallback (the simple case)

No extension, no adapter, no JIT: use when the maker ALREADY HOLDS the asset it sells (e.g. an
underwriter that pre-minted cST via `deposit`). Plain traits (expiry + nonce + fill flags
only), any unique salt, empty `extension` in the POST. Cost: capital sits locked while the
order rests; an unfilled expiry leaves you holding cPT + cST to unwind. Scripts:
`docs/examples/plain-order.mjs` (`SIDE=SELL|BUY`) / `plain-fill.mjs`; walkthrough
`docs/examples/plain-order.md`.

A later phase ("CGB": Cork-owned settlement, premium-APY pricing, maker hooks, N-order fills)
exists but is not live; this file covers the live adapter path.
