import { createPublicClient, http, parseAbi, getAddress, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';

async function main() {
  const client = createPublicClient({ chain: arbitrum, transport: http(process.env.RPC_URL) });
  const poolId = (process.env.POOL_ID ?? '0xcc6efddfcaa194769316269616157c3fa0b24a55d3187e935c79e70b61ca50d4') as `0x${string}`;
  const bond = getAddress('0x9560Ee3BEFc1Bb7f9Cef8A6a904e04a948fD6bd9');
  const poolManager = getAddress(process.env.CORK_POOL_MANAGER!);

  console.log('poolManager', poolManager);
  console.log('poolId', poolId);

  const market = await client.readContract({
    address: poolManager,
    abi: parseAbi([
      'function market(bytes32) view returns (address collateralAsset, address referenceAsset, uint256 expiryTimestamp, uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax, address rateOracle)',
    ]),
    functionName: 'market',
    args: [poolId],
  });
  const [caToken, refToken, expiry, rateMin, rateMax, rateChangePerDayMax, rateChangeCapacityMax, rateOracle] = market;
  console.log('CA token:', caToken);
  console.log('Reference token:', refToken);
  console.log('Expiry:', new Date(Number(expiry) * 1000).toISOString());
  console.log('Rate oracle:', rateOracle);

  const [cpt, cst] = await client.readContract({
    address: poolManager,
    abi: parseAbi(['function shares(bytes32) view returns (address principalToken, address swapToken)']),
    functionName: 'shares',
    args: [poolId],
  });
  console.log('cPT (principal):', cpt);
  console.log('cST (swap/cover):', cst);

  const caBal = await client.readContract({
    address: caToken,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [bond],
  });
  const cptBal = await client.readContract({ address: cpt, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [bond] });
  const cstBal = await client.readContract({ address: cst, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [bond] });

  console.log('Bond CA balance:', caBal.toString(), formatUnits(caBal, 6));
  console.log('Bond cPT balance:', cptBal.toString());
  console.log('Bond cST balance:', cstBal.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
