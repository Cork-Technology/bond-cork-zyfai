# Contract makers — the same order, the other signature branch

Step 3 of the ladder. A maker that is a smart contract (a Safe, or here a
minimal ERC-1271 wallet) posts the SAME order bytes as an EOA — same struct,
same extension mechanics, same salt commitment, same maker traits. Exactly
two things change, and both are the `makerAccountType` rule from
[`ceremony.md`](./ceremony.md):

1. **How the order is signed.** There is no private key to recover against
   the maker address. Instead, an owner key signs the EIP-712 order hash and
   the maker CONTRACT vouches for it: verifiers call
   `maker.isValidSignature(orderHash, signature)` (ERC-1271) and expect the
   magic value `0x1626ba7e`. The API does this check at POST time; the LOP
   does it again on-chain at fill time.
2. **Which fill function the counterparty uses.** `fillOrderArgs` takes the
   signature as two words (EIP-2098 compact `r`/`vs`) and ECDSA-recovers the
   maker — that recovery can never yield a contract address, so it reverts
   `BadSignature` for contract makers. The contract variant,
   `fillContractOrderArgs(order, signature, amount, takerTraits, args)`,
   carries the signature as RAW BYTES and delegates the check to the maker's
   `isValidSignature`.

Everything else — amounts, threshold math, the extension bytes riding in
`args`, partial fills — is byte-identical to the EOA path. In particular the
JIT recipe is unchanged: pre-interaction slot = `adapter ++
abi.encode(poolId)`, salt low 160 bits = `keccak256(extension)` low 160
bits, maker traits bits 249 (HAS_EXTENSION) + 252 (PRE_INTERACTION). Proven
against the real LOP on a fork by
[`test/fork/ContractMakerFill.fork.t.sol`](../../test/fork/ContractMakerFill.fork.t.sol).

## The wallet

[`test/mocks/ERC1271Wallet.sol`](../../test/mocks/ERC1271Wallet.sol) — the
smallest contract that can be a maker: it holds the tokens, validates
signatures against one configured owner key via `ecrecover`, and exposes an
owner-gated `execute(target, data)` passthrough so the wallet itself can
issue the ERC-20 approvals (approvals must come FROM the maker address —
the LOP and the adapter pull from `order.maker`, not from whoever signed).

## What changes with a real Safe

The fill path is identical — `fillContractOrderArgs`, raw signature bytes,
ERC-1271 verification. The difference is what the owner keys sign: a Safe
does not validate the raw order hash. It wraps the message in its own
EIP-712 **SafeMessage** envelope (`SafeMessage(bytes message)`, domain =
the Safe's own address and chain id) and its `isValidSignature` checks the
owners' signatures against THAT wrapped hash. So with Safe tooling you sign
`SafeMessage(orderHash)` (plus collect threshold signatures); with this
minimal wallet you sign `orderHash` directly. Approvals go through the
Safe's `execTransaction` instead of `execute`. Nothing on the LOP or
adapter side changes.

## Run it

Both scripts run against a bare anvil fork (no orderbook API): the order
travels through a local JSON handoff file. With `ORDERBOOK_URL` set, they
use the book instead (`makerAccountType: "CONTRACT"` in the POST; takers
read the field back and branch).

Maker — deploy the wallet from the Foundry artifact (run `forge build`
first), fund it, approve, sign, hand off. The variant switch mirrors
`plain-order.mjs`'s `SIDE`:

```
# JIT (default): nothing minted upfront, the signed extension mints at fill
VARIANT=JIT PRIVATE_KEY=0x... RPC_URL=... POOL_MANAGER=0x... POOL_ID=0x... \
  ADAPTER=0x... CST=0x... CA=0x... CA_DECIMALS=6 \
  SIZE_CST=20000000000000000000000 PRICE_CA_PER_CST=0.02 \
  node contract-order.mjs

# PLAIN: the wallet pre-mints the cST it sells (the pre-deposit JIT eliminates)
VARIANT=PLAIN ... node contract-order.mjs
```

Taker — read the handoff (or the book), branch on `makerAccountType`, fill:

```
PRIVATE_KEY=0x... RPC_URL=... node contract-fill.mjs
```

Taker prereq: approve CA → LOP (you pay the premium; for the JIT variant
the cST you receive is minted by the wallet's hook inside the same
transaction).

## The errors you will actually hit

| Revert | Cause |
|---|---|
| `BadSignature` | wrong branch: `fillOrderArgs` on a contract maker (or `fillContractOrderArgs` with a signature the wallet's owner did not produce) |
| `TransferFromMakerToTakerFailed` | the wallet never approved cST → LOP, or (PLAIN) was never funded/pre-minted |
| adapter reverts (`MintUnavailable`, …) | same meanings as the EOA JIT path — see [`jit-order.md`](./jit-order.md) |
