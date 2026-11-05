// Child checks can change cwd (for example, to apps/community-api).
const preloadOption = `--require="${require.resolve('./node-os-userinfo-fallback.cjs').replace(/\\/g, '/')}"`;
const existingNodeOptions = process.env.NODE_OPTIONS || '';
if (!existingNodeOptions.includes('node-os-userinfo-fallback.cjs')) {
  process.env.NODE_OPTIONS = `${existingNodeOptions} ${preloadOption}`.trim();
}

require('./node-os-userinfo-fallback.cjs');

// Old scene fixtures opt into an explicitly installed package; the terminal itself starts empty.
const noPack = process.argv.indexOf('--no-scene-pack-bootstrap');
if (noPack >= 0) process.argv.splice(noPack, 1);
else if (/^scripts[\\/]check-scene/.test(process.argv[2] || '')) {
  process.argv.splice(2, 0, 'scripts/run-scene-check.ts');
}

import('../node_modules/tsx/dist/cli.mjs').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

