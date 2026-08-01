import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.PRIMEPROP_BASE_URL || '').replace(/\/+$/, '');
let bearer = (process.env.PRIMEPROP_ADMIN_BEARER || '').trim();
let adminEmail = (process.env.PRIMEPROP_ADMIN_EMAIL || '').trim().toLowerCase();
let adminPassword = process.env.PRIMEPROP_ADMIN_PASSWORD || '';
const outputDirectory = path.resolve(process.cwd(), process.env.PRIMEPROP_AUDIT_OUTPUT || 'audit-output');

function isPlaceholder(value) {
  return /^<[^>]+>$/.test(String(value).trim());
}

function promptTerminal(label, { secret = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve('');

  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = Boolean(input.isRaw);

  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;

    function cleanup() {
      input.removeListener('data', onData);
      if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
      input.pause();
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      resolve(result);
    }

    function cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      reject(new Error('Administrator credential input was cancelled.'));
    }

    function onData(chunk) {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cancel();
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (!secret) output.write('\b \b');
          }
          continue;
        }
        if (character >= ' ') {
          value += character;
          if (!secret) output.write(character);
        }
      }
    }

    output.write(label);
    input.setEncoding('utf8');
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
  console.error('Set PRIMEPROP_BASE_URL to the deployed HTTPS application origin.');
  process.exit(2);
}

if (isPlaceholder(bearer)) {
  console.error('PRIMEPROP_ADMIN_BEARER still contains a placeholder. Supply a real access token or use administrator login.');
  process.exit(2);
}
if (isPlaceholder(adminEmail) || isPlaceholder(adminPassword)) {
  console.error('Administrator login variables still contain placeholders. Supply real values without angle brackets.');
  process.exit(2);
}

if (!bearer && process.stdin.isTTY && process.stdout.isTTY) {
  try {
    if (!adminEmail) {
      adminEmail = (await promptTerminal('Administrator email: ')).trim().toLowerCase();
    }
    if (!adminPassword) {
      adminPassword = await promptTerminal('Administrator password: ', { secret: true });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Administrator credential input was cancelled.');
    process.exit(130);
  }
}

async function obtainAdministratorBearer() {
  if (bearer) return bearer;
  if (!adminEmail || !adminPassword) return '';

  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    redirect: 'error',
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error(`Administrator login returned non-JSON HTTP ${response.status}.`);
    process.exit(1);
  }

  if (!response.ok || payload?.success !== true) {
    console.error(JSON.stringify({
      event: 'remote_storage_audit_login_failed',
      status: response.status,
      message: payload?.message || 'Administrator login failed',
    }));
    process.exit(1);
  }

  if (payload?.data?.user?.role !== 'admin') {
    console.error('The supplied account is authenticated but is not an administrator.');
    process.exit(1);
  }

  const token = String(payload?.data?.token || '').trim();
  if (!token) {
    console.error('Administrator login succeeded but returned no access token.');
    process.exit(1);
  }

  // Do not print or persist the temporary access token.
  return token;
}

bearer = await obtainAdministratorBearer();
adminPassword = '';
process.env.PRIMEPROP_ADMIN_PASSWORD = '';

if (!bearer) {
  console.error([
    'Administrator authentication is required.',
    'Run this command in an interactive terminal to be prompted securely,',
    'or set PRIMEPROP_ADMIN_BEARER to a current administrator access token.',
    'Do not include literal <placeholder> text.',
  ].join(' '));
  process.exit(2);
}

const response = await fetch(`${baseUrl}/auth/security/storage-audit`, {
  headers: {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json',
  },
  redirect: 'error',
});

const text = await response.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  console.error(`Storage audit returned non-JSON HTTP ${response.status}.`);
  process.exit(1);
}

if (!response.ok || payload?.success !== true) {
  console.error(JSON.stringify({
    event: 'remote_storage_audit_failed',
    status: response.status,
    message: payload?.message || 'Unknown response',
    remediation: response.status === 401
      ? 'Use a current active administrator account or bearer token and rerun the audit.'
      : undefined,
  }));
  process.exit(1);
}

await mkdir(outputDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = path.join(outputDirectory, `primeprop-storage-audit-${timestamp}.json`);
const markdownPath = path.join(outputDirectory, `primeprop-storage-audit-${timestamp}.md`);
const report = payload.data;
const counts = report.counts || {};
const issues = Array.isArray(report.issues) ? report.issues : [];

const markdown = [
  '# PrimeProp remote storage audit',
  '',
  `Generated: ${report.generatedAt || new Date().toISOString()}`,
  '',
  '## Counts',
  '',
  `- R2 objects: ${counts.r2Objects ?? 'unknown'}`,
  `- Upload ownership rows: ${counts.uploadRows ?? 'unknown'}`,
  `- Application media references: ${counts.mediaReferences ?? 'unknown'}`,
  `- Total issues: ${counts.issues ?? issues.length}`,
  `- High severity: ${counts.high ?? 'unknown'}`,
  `- Medium severity: ${counts.medium ?? 'unknown'}`,
  '',
  '## Findings',
  '',
  ...(issues.length === 0
    ? ['No integrity issues were reported.']
    : issues.map((issue, index) => {
        const target = issue.key
          ? `key \`${String(issue.key).replace(/`/g, '')}\``
          : `${issue.source || 'record'} ${issue.sourceId || ''}`.trim();
        return `${index + 1}. **${String(issue.severity).toUpperCase()}** ${issue.category}: ${target}. ${issue.detail}`;
      })),
  '',
  'This report is read-only. No D1 row or R2 object was changed or deleted.',
  '',
].join('\n');

await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
await writeFile(markdownPath, markdown, { mode: 0o600 });

console.log(JSON.stringify({
  event: 'remote_storage_audit_completed',
  jsonPath,
  markdownPath,
  counts,
}));

if ((counts.high || 0) > 0) process.exitCode = 3;
