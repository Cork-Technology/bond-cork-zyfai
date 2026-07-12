import { createPublicClient, http, parseAbi, getAddress, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';

async function main() {
  const client = createPublicClient({ chain: arbitrum, transport: http(process.env.RPC_URL) });
  const poolId = (process.env.POOL_ID ?? '0x') as `0x${string}`;
  const poolManager = getAddress(process.env.CORK_POOL_MANAGER!);
  const pmAbi = parseAbi([
    'function previewExercise(bytes32 poolId, uint256 cstSharesIn) view returns (uint256 collateralAssetsOut, uint256 referenceAssetsIn, uint256 fee)',
    'function swapRate(bytes32 poolId) view returns (uint256 rate)',
    'function swapFee(bytes32 poolId) view returns (uint256)',
  ]);
  const preview = await client.readContract({ address: poolManager, abi: pmAbi, functionName: 'previewExercise', args: [poolId, 10n ** 18n] });
  console.log('previewExercise(1e18 cST):', preview);
  console.log('collateral out sUSDe:', formatUnits(preview[0], 18));
  console.log('reference in yoUSD:', formatUnits(preview[1], 6));
  console.log('fee sUSDe:', formatUnits(preview[2], 18));
  const rate = await client.readContract({ address: poolManager, abi: pmAbi, functionName: 'swapRate', args: [poolId] });
  console.log('swapRate:', formatUnits(rate, 18));
  const fee = await client.readContract({ address: poolManager, abi: pmAbi, functionName: 'swapFee', args: [poolId] });
  console.log('swapFee:', formatUnits(fee, 18), '%');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
