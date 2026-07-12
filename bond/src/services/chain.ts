import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const);

export const poolManagerAbi = parseAbi([
  'function market(bytes32 poolId) view returns ((address collateralAsset, address referenceAsset, uint256 expiryTimestamp, uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax, address rateOracle))',
  'function assets(bytes32 poolId) view returns (uint256 collateralAssets, uint256 referenceAssets)',
  'function shares(bytes32 poolId) view returns (address principalToken, address swapToken)',
  'function swapRate(bytes32 poolId) view returns (uint256 rate)',
  'function getPausedBitMap(bytes32 poolId) view returns (uint16)',
  'function swapFee(bytes32 poolId) view returns (uint256)',
  'function unwindSwapFee(bytes32 poolId) view returns (uint256)',
  'function previewMint(bytes32 poolId, uint256 shares) view returns (uint256 assets)',
  'function maxMint(bytes32 poolId, address owner) view returns (uint256 maxShares)',
  'function previewRedeem(bytes32 poolId, uint256 shares) view returns (uint256 collateralAssets, uint256 referenceAssets)',
  'function maxRedeem(bytes32 poolId, address owner) view returns (uint256 maxShares)',
  'function redeem(bytes32 poolId, uint256 shares, address owner, address receiver) returns (uint256 referenceAssets, uint256 collateralAssets)',
] as const);

export const lopAbi = parseAbi([
  'function fillOrderArgs((uint256 salt, uint256 maker, uint256 receiver, uint256 makerAsset, uint256 takerAsset, uint256 makingAmount, uint256 takingAmount, uint256 makerTraits) order, bytes32 r, bytes32 vs, uint256 amount, uint256 takerTraits, bytes args) payable returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)',
  'function fillContractOrderArgs((uint256 salt, uint256 maker, uint256 receiver, uint256 makerAsset, uint256 takerAsset, uint256 makingAmount, uint256 takingAmount, uint256 makerTraits) order, bytes signature, uint256 amount, uint256 takerTraits, bytes args) returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)',
  'function hashOrder((uint256 salt, uint256 maker, uint256 receiver, uint256 makerAsset, uint256 takerAsset, uint256 makingAmount, uint256 takingAmount, uint256 makerTraits) order) view returns (bytes32)',
  'function cancelOrder((uint256 salt, uint256 maker, uint256 receiver, uint256 makerAsset, uint256 takerAsset, uint256 makingAmount, uint256 takingAmount, uint256 makerTraits) order) returns (bytes32 orderHash)',
] as const);

export const account = privateKeyToAccount(env.BOND_EOA_PRIVATE_KEY);

export const publicClient = createPublicClient({
  chain: arbitrum,
  transport: http(env.RPC_URL),
});

export const walletClient = createWalletClient({
  account,
  chain: arbitrum,
  transport: http(env.RPC_URL),
});

export const BOND_ADDRESS: Hex = account.address;

logger.info(
  { bondAddress: BOND_ADDRESS },
  'Bond underwriting agent chain clients initialized on Arbitrum One',
);
