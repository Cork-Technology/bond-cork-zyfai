/**
 * Print the live Cork deployment on the target chain (default 8453 / Base),
 * plus registered assets and approved recipes. Read-only; never signs.
 *
 * Usage:  npm run discover:cork [-- --chain-id 42161]
 *
 * Follow-up: pick a (REF, CA, recipe, expiry) tuple, then verify pair
 * compatibility with `ch query registry-oracle` or derive the future pool
 * with `ch query derive-cork-pool`.
 */
import {
  queryProtocolConfig,
  queryRegistryAssets,
  queryRegistryRecipes,
  CorkError,
  type Asset,
} from '../services/cork-cli.js';

function parseChainId(argv: string[]): number {
  const idx = argv.indexOf('--chain-id');
  if (idx >= 0 && argv[idx + 1]) return Number(argv[idx + 1]);
  return 8453;
}

function pad(str: string | undefined, width: number): string {
  const s = str ?? '';
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function sourceLabel(a: Asset, kind: 'price' | 'nav'): string {
  const src = kind === 'price' ? a.priceSource : a.navSource;
  return src ? src.denomination : '-';
}

async function main(): Promise<void> {
  const chainId = parseChainId(process.argv.slice(2));
  console.log(`chain: ${chainId}`);
  console.log('');

  console.log('--- protocol deployment ---');
  const config = await queryProtocolConfig(chainId);
  const d = config.deployment;
  console.log(`  poolManager        ${d.poolManager}`);
  console.log(`  corkAdapter        ${d.corkAdapter}   [raw JIT adapter — DO NOT whitelist]`);
  console.log(`  constraintAdapter  ${d.constraintAdapter}`);
  console.log(`  bundler3           ${d.bundler3}`);
  console.log(`  whitelistManager   ${d.whitelistManager}`);
  console.log('');

  console.log('--- registered assets ---');
  const assets = await queryRegistryAssets(chainId);
  console.log(
    `  ${pad('symbol', 14)} ${pad('kind', 12)} ${pad('price', 8)} ${pad('nav', 8)} ${pad('dec', 4)} address`,
  );
  for (const a of assets) {
    console.log(
      `  ${pad(a.token.symbol, 14)} ${pad(a.kind, 12)} ${pad(sourceLabel(a, 'price'), 8)} ${pad(sourceLabel(a, 'nav'), 8)} ${pad(String(a.token.decimals), 4)} ${a.address}`,
    );
  }
  console.log('');

  console.log('--- approved recipes ---');
  const recipes = await queryRegistryRecipes(chainId);
  for (const r of recipes) {
    console.log(`  ${pad(r.source, 8)} ${r.address}`);
  }
  console.log('');

  console.log('--- next step ---');
  console.log('  Pick REF (what to cover) + CA (premium/payout) + recipe + expiry, then:');
  console.log(
    `    ch query registry-oracle --chain-id ${chainId} --collateral-asset <CA> --reference-asset <REF> --oracle-mode <price|nav>`,
  );
  console.log(
    `    ch query derive-cork-pool --chain-id ${chainId} --collateral-asset <CA> --reference-asset <REF> --expiry <unix> --recipe <recipe-address>`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof CorkError) {
    console.error(`\ncork-cli error (${error.name}): ${error.message}`);
    if (error.warnings.length) console.error('warnings:', JSON.stringify(error.warnings, null, 2));
    process.exit(2);
  }
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`\nFAILED: ${detail}`);
  process.exit(1);
});
