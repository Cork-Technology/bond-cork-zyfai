import { createPublicClient, http, parseAbi, getAddress, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';

async function main() {
  const client = createPublicClient({ chain: arbitrum, transport: http(process.env.RPC_URL) });
  const poolId = process.env.POOL_ID as `0x${string}`;
  const pm = getAddress(process.env.CORK_POOL_MANAGER!);
  const assets = await client.readContract({
    address: pm,
    abi: parseAbi(['function assets(bytes32) view returns (uint256 collateralAssets, uint256 referenceAssets)']),
    functionName: 'assets',
    args: [poolId],
  });
  console.log('Pool collateral (sUSDe):', formatUnits(assets[0], 18));
  console.log('Pool reference (yoUSD):', formatUnits(assets[1], 6));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
