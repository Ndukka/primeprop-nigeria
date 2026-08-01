import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const EXPECTED_WRANGLER_VERSION = '4.118.0';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(scriptDirectory, '..');

const candidatePackageFiles = [
  path.join(workerDirectory, 'node_modules', 'wrangler', 'package.json'),
  path.join(
    workerDirectory,
    'node_modules',
    '@cloudflare',
    'vitest-pool-workers',
    'node_modules',
    'wrangler',
    'package.json',
  ),
];

const packageFile = candidatePackageFiles.find(existsSync);
if (!packageFile) {
  console.error('The tested Wrangler package is not installed. Run npm ci from worker/ first.');
  process.exit(2);
}

let packageJson;
try {
  packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
} catch {
  console.error(`Unable to read the installed Wrangler package at ${packageFile}.`);
  process.exit(2);
}

if (packageJson.version !== EXPECTED_WRANGLER_VERSION) {
  console.error(
    `Refusing to run Wrangler ${packageJson.version || 'unknown'}. `
    + `This repository is validated with Wrangler ${EXPECTED_WRANGLER_VERSION}. Run npm ci and retry.`,
  );
  process.exit(2);
}

const packageDirectory = path.dirname(packageFile);
const configuredBin = typeof packageJson.bin === 'string'
  ? packageJson.bin
  : packageJson.bin?.wrangler;

if (!configuredBin) {
  console.error('The installed Wrangler package does not expose its CLI entry point.');
  process.exit(2);
}

const wranglerBin = path.resolve(packageDirectory, configuredBin);
if (!existsSync(wranglerBin)) {
  console.error(`The tested Wrangler CLI entry point is missing: ${wranglerBin}`);
  process.exit(2);
}

console.log(JSON.stringify({
  event: 'primeprop_wrangler_selected',
  version: packageJson.version,
  packageFile: path.relative(workerDirectory, packageFile).replaceAll('\\', '/'),
}));

const result = spawnSync(process.execPath, [wranglerBin, ...process.argv.slice(2)], {
  cwd: workerDirectory,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.signal) {
  console.error(`Wrangler terminated by signal ${result.signal}.`);
  process.exit(1);
}

process.exit(result.status ?? 1);
