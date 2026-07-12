// Post an opening BUY bid from a Safe (ERC-1271) maker.
//
// The Safe does NOT sign the raw EIP-712 order hash. It wraps it in its own
// SafeMessage(bytes message) envelope and the owner signs THAT hash. The
// signature is posted as raw 65 bytes with makerAccountType: "CONTRACT".
//
// Prereqs: Safe holds CA and has approved CA -> 1inch LOP.
//
// env: PRIVATE_KEY      owner EOA of the Safe
//      RPC_URL
//      ORDERBOOK_URL    https://api-phoenix.cork.tech
//      SAFE_ADDRESS     the Safe smart wallet address
//      CA
//      CA_DECIMALS
//      CST              the pool's swapToken (cST)
//      POOL_ID
//      SIZE_CST
//      PRICE_CA_PER_CST
//      EXPIRY_SECONDS
//      PREMIUM_DISPLAY

import {
  createPublicClient,
  hashTypedData,
  http,
  keccak256,
  encodeAbiParameters,
  concatHex,
  parseAbi,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { buildMakerTraits, orderExpiry, orderTypedData } from "./lib.mjs";

const SAFE_MSG_TYPEHASH = "0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca";
const EIP1271_MAGIC_VALUE = "0x1626ba7e";

const E = process.env;

function requireEnv(name) {
  const value = E[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function requireAddress(name) {
  const value = requireEnv(name);
  if (!isAddress(value)) throw new Error(`Invalid address in ${name}: ${value}`);
  return value;
}

const privateKey = requireEnv("PRIVATE_KEY");
const rpcUrl = requireEnv("RPC_URL");
const orderbookUrl = requireEnv("ORDERBOOK_URL");
const safeAddress = requireAddress("SAFE_ADDRESS");
const ca = requireAddress("CA");
const cst = requireAddress("CST");
const poolId = requireEnv("POOL_ID");

const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });

const sizeCst = BigInt(E.SIZE_CST);
const caDecimals = BigInt(E.CA_DECIMALS);
const PRICE_SCALE = 1_000_000_000n;
const priceScaled = BigInt(Math.round(Number(E.PRICE_CA_PER_CST) * 1e9));
const premiumCa =
  (sizeCst * priceScaled * 10n ** caDecimals + (PRICE_SCALE * 10n ** 18n - 1n)) /
  (PRICE_SCALE * 10n ** 18n);

const nowSeconds = Math.floor(Date.now() / 1000);
const expiry = orderExpiry(E.EXPIRY_SECONDS ?? 3600, nowSeconds);
const nonce = BigInt(nowSeconds) & ((1n << 40n) - 1n);
const makerTraits = buildMakerTraits({ expiry, nonce, allowPartialFills: true, allowMultipleFills: true });

const order = {
  salt: BigInt(Date.now()),
  maker: safeAddress,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: ca,
  takerAsset: cst,
  makingAmount: premiumCa,
  takingAmount: sizeCst,
  makerTraits,
};

const typed = orderTypedData(arbitrum.id, order);
const orderHash = hashTypedData(typed);

// Compute SafeMessage(orderHash) hash exactly as Safe's CompatibilityFallbackHandler does.
const domainSeparator = await publicClient.readContract({
  address: safeAddress,
  abi: parseAbi(["function domainSeparator() view returns (bytes32)"]),
  functionName: "domainSeparator",
});

const safeMessageHash = keccak256(
  concatHex([
    "0x1901",
    domainSeparator,
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }],
        [SAFE_MSG_TYPEHASH, keccak256(orderHash)],
      ),
    ),
  ]),
);

// Sign the SafeMessage hash with the owner key (raw 65-byte signature).
const signature = await account.sign({ hash: safeMessageHash });

// Optional but strongly recommended: verify locally before POSTing.
try {
  const magic = await publicClient.readContract({
    address: safeAddress,
    abi: parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]),
    functionName: "isValidSignature",
    args: [orderHash, signature],
  });
  if (magic !== EIP1271_MAGIC_VALUE) {
    throw new Error(`isValidSignature returned ${magic}, expected ${EIP1271_MAGIC_VALUE}`);
  }
  console.log("Safe signature verified locally");
} catch (err) {
  console.warn("Could not verify signature on-chain:", err.message ?? err);
  console.warn("Continuing anyway — the API will validate at POST time.");
}

// The Safe must have approved CA to the 1inch LOP contract. Without this the
// taker's fill will revert with TransferFromMakerToTakerFailed.
const lopAddress = "0x111111125421cA6dc452d289314280a0f8842A65";
const allowance = await publicClient.readContract({
  address: ca,
  abi: parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]),
  functionName: "allowance",
  args: [safeAddress, lopAddress],
});
if (allowance < premiumCa) {
  console.error(
    `Safe CA allowance for 1inch LOP is insufficient: ${allowance} < ${premiumCa}.`,
    `Approve the Safe first: cd cork/docs/examples && SAFE_ADDRESS=${safeAddress} CA=${ca} ZYFAI_TX_URL=http://localhost:3000/tx npx tsx approve-safe-ca-to-lop.mjs`,
  );
  process.exit(1);
}
console.log("Safe CA allowance OK:", allowance.toString());

const payload = {
  salt: order.salt.toString(),
  maker: order.maker,
  receiver: order.receiver,
  makerAsset: order.makerAsset,
  takerAsset: order.takerAsset,
  makingAmount: premiumCa.toString(),
  takingAmount: sizeCst.toString(),
  makerTraits: makerTraits.toString(),
  orderHash,
  signature,
  makerAccountType: "CONTRACT",
  makerPermit2: "",
  extension: "",
  side: "BUY",
  premium: Number(E.PREMIUM_DISPLAY ?? 0),
  expiry,
  nonce: nonce.toString(),
  allowsPartialFills: true,
  chainId: arbitrum.id,
  poolId,
};

async function postWithRetry(maxAttempts = 12, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${orderbookUrl}/v1/limit-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (res.ok) {
      console.log("Safe bid posted:", body);
      return;
    }
    console.log(`attempt ${attempt}/${maxAttempts} failed:`, res.status, body.message ?? body.error ?? body);
    if (attempt < maxAttempts) {
      console.log(`waiting ${delayMs}ms before retry...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("failed to post Safe bid after retries");
}

await postWithRetry();
