import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, '..');
const repositoryDir = path.resolve(workerDir, '..');
const loginPath = path.join(repositoryDir, 'public', 'login.html');
const strictBuildPath = path.join(scriptDir, 'run-strict-public-build.mjs');

const LOGIN_SOURCE_REPLACEMENTS = new Map([
  [
    "    function showSignup() { document.getElementById('loginCard').style.display = 'none'; document.getElementById('signupCard').style.display = 'block'; }",
    [
      '    function showSignup() {',
      "      document.getElementById('loginCard').style.display = 'none';",
      "      document.getElementById('signupCard').style.display = 'block';",
      '    }',
    ].join('\n'),
  ],
  [
    "    function showLogin() { document.getElementById('signupCard').style.display = 'none'; document.getElementById('loginCard').style.display = 'block'; }",
    [
      '    function showLogin() {',
      "      document.getElementById('signupCard').style.display = 'none';",
      "      document.getElementById('loginCard').style.display = 'block';",
      '    }',
    ].join('\n'),
  ],
]);

function prepareLoginSource(source) {
  let prepared = source;

  for (const [original, replacement] of LOGIN_SOURCE_REPLACEMENTS) {
    if (!prepared.includes(original)) {
      throw new Error('Login source normalization target was not found; inspect public/login.html before building.');
    }
    prepared = prepared.replace(original, replacement);
  }

  return prepared;
}

const originalLoginSource = await readFile(loginPath, 'utf8');
const preparedLoginSource = prepareLoginSource(originalLoginSource);
let result;

try {
  await writeFile(loginPath, preparedLoginSource, 'utf8');
  result = spawnSync(process.execPath, [strictBuildPath], {
    cwd: workerDir,
    stdio: 'inherit',
    env: process.env,
  });
} finally {
  await writeFile(loginPath, originalLoginSource, 'utf8');
}

if (result?.error) throw result.error;
if (result?.status !== 0) process.exitCode = result?.status ?? 1;
