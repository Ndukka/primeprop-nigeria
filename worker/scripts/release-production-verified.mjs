import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(scriptDirectory, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message, exitCode = 1) {
  console.error(JSON.stringify({
    event: 'primeprop_production_release_failed',
    message,
  }));
  process.exit(exitCode);
}

function run(command, args, label, capture = false) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: workerDirectory,
    env: process.env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });

  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.signal) fail(`${label} terminated by signal ${result.signal}.`);
  if ((result.status ?? 1) !== 0) {
    fail(`${label} failed. Deployment was not started.`, result.status ?? 1);
  }

  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

const baseUrl = process.env.PRIMEPROP_BASE_URL || '';
let parsedBaseUrl;
try {
  parsedBaseUrl = new URL(baseUrl);
} catch {
  fail('Set PRIMEPROP_BASE_URL to the exact HTTPS production origin before running this command.');
}
if (parsedBaseUrl.protocol !== 'https:' || parsedBaseUrl.pathname !== '/' || parsedBaseUrl.search || parsedBaseUrl.hash) {
  fail('PRIMEPROP_BASE_URL must be an HTTPS origin without a path, query string, or fragment.');
}

const wrangler = [process.execPath, './scripts/run-wrangler.mjs'];
const runWrangler = (args, label, capture = false) => run(wrangler[0], [...wrangler.slice(1), ...args], label, capture);

runWrangler(
  ['d1', 'migrations', 'list', 'primeprop-db', '--remote'],
  'CHECK REMOTE D1 MIGRATIONS',
);

runWrangler(
  ['d1', 'migrations', 'apply', 'primeprop-db', '--remote'],
  'APPLY REMOTE D1 MIGRATIONS',
);

const postMigrationList = stripAnsi(runWrangler(
  ['d1', 'migrations', 'list', 'primeprop-db', '--remote'],
  'VERIFY REMOTE D1 MIGRATIONS',
  true,
));
if (/Migrations to be applied/i.test(postMigrationList)) {
  fail('Remote D1 still reports unapplied migrations. Deployment was not started.');
}

run(npmCommand, ['run', 'deploy:verified'], 'DEPLOY AND VERIFY WORKER');

console.log(JSON.stringify({
  event: 'primeprop_production_release_passed',
  baseUrl: parsedBaseUrl.origin,
  migrationsVerified: true,
}));
