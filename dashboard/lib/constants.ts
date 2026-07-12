export const PHOENIX_API_URL =
  process.env.NEXT_PUBLIC_PHOENIX_API_URL ?? "https://api-phoenix.cork.tech";
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ??
  "https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY";
export const ZYFAI_URL =
  process.env.NEXT_PUBLIC_ZYFAI_URL ?? "http://localhost:3000";
export const BOND_URL =
  process.env.NEXT_PUBLIC_BOND_URL ?? "http://localhost:4000";
export const SAFE_ADDRESS =
  process.env.NEXT_PUBLIC_SAFE_ADDRESS ??
  "0x069Aa4242E08A9A694E52428d27182D5905BB05c";
export const BOND_ADDRESS =
  process.env.NEXT_PUBLIC_BOND_ADDRESS ??
  "0x9560Ee3BEFc1Bb7f9Cef8A6a904e04a948fD6bd9";
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "42161");

export const KNOWN_POOLS = {
  USDC_yoUSD:
    "0xcc6efddfcaa194769316269616157c3fa0b24a55d3187e935c79e70b61ca50d4",
  sUSDe_yoUSD:
    "0xc0bafd4bb989adf53cd1c8a6e848afef922ab1b958281f91c0af70bc37f8dd1a",
} as const;

// Last-synced snapshots of the two known markets, used as a fallback if the
// Phoenix pools API is unreachable from the browser.
export const FALLBACK_POOLS = [
  {
    chainId: 42161,
    poolId:
      "0xcc6efddfcaa194769316269616157c3fa0b24a55d3187e935c79e70b61ca50d4",
    poolName: "USDC-yoUSD-12JUL2026",
    expiry: "2026-07-12T14:24:09.000Z",
    deploymentTxHash:
      "0x39987fd157a8f6d0ebaa6a9b8e69f84b057282ba8087d36c44e3dda2557ef1db",
    poolManagerAddress: "0xc2de56fb1c7a85250ce69c37b4773767c77954ae",
    collateralToken: {
      address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
    },
    referenceToken: {
      address: "0x0000000f2eb9f69274678c76222b35eec7588a65",
      name: "yoVaultUSD",
      symbol: "yoUSD",
      decimals: 6,
    },
    principalToken: {
      address: "0xa5700f9e8e6121a275d64471a58c7e1aa9e7c5ef",
      name: "USDC-yoUSD7cPT",
      symbol: "yoUSD7cPT",
      decimals: 18,
    },
    swapToken: {
      address: "0x5b9d47f874c56ae2919b37ad8e584926eca3b244",
      name: "USDC-yoUSD7cST",
      symbol: "yoUSD7cST",
      decimals: 18,
    },
    isWhitelistEnabled: false,
    isDepositPaused: false,
    isWithdrawPaused: false,
    isSwapPaused: false,
    tvl: { inUsdAtNow: 0 },
    collateralValue: { inWei: "0", inToken: 0 },
  },
  {
    chainId: 42161,
    poolId:
      "0xc0bafd4bb989adf53cd1c8a6e848afef922ab1b958281f91c0af70bc37f8dd1a",
    poolName: "sUSDe-yoUSD-12JUL2026",
    expiry: "2026-07-12T17:04:03.000Z",
    deploymentTxHash:
      "0x9707d9079e6929c35adb90c38fe06c4743ce84641a68ea854749ed9147f4eae5",
    poolManagerAddress: "0xc2de56fb1c7a85250ce69c37b4773767c77954ae",
    collateralToken: {
      address: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2",
      name: "Staked USDe",
      symbol: "sUSDe",
      decimals: 18,
    },
    referenceToken: {
      address: "0x0000000f2eb9f69274678c76222b35eec7588a65",
      name: "yoVaultUSD",
      symbol: "yoUSD",
      decimals: 6,
    },
    principalToken: {
      address: "0x197d5aa3f2d0bd1d4063a96e59a381232d95f8af",
      name: "sUSDe-yoUSD7cPT",
      symbol: "yoUSD7cPT",
      decimals: 18,
    },
    swapToken: {
      address: "0x834d55a0916366640ca27cb88907b471ce7ed05a",
      name: "sUSDe-yoUSD7cST",
      symbol: "yoUSD7cST",
      decimals: 18,
    },
    isWhitelistEnabled: false,
    isDepositPaused: false,
    isWithdrawPaused: false,
    isSwapPaused: false,
    tvl: { inUsdAtNow: 0 },
    collateralValue: { inWei: "0", inToken: 0 },
  },
] as const;

export const CONTRACTS = {
  POOL_MANAGER: "0xc2De56fb1C7a85250ce69C37B4773767C77954AE",
  LOP: "0x111111125421cA6dc452d289314280a0f8842A65",
  ADAPTER: "0xc915B0776189E5Fa021C60D76Da0c8D7F1997801",
  MARKET_CREATOR: "0x4B5B91cF4d1DAdb7439beB68926c86D2D8C68dBC",
} as const;

export function arbiscanTx(hash: string) {
  return `https://arbiscan.io/tx/${hash}`;
}
