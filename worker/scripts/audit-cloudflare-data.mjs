import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.PRIMEPROP_BASE_URL || '').replace(/\/+$/, '');
const bearer = process.env.PRIMEPROP_ADMIN_BEARER || '';
const outputDirectory = path.resolve(process.cwd(), process.env.PRIMEPROP_AUDIT_OUTPUT || 'audit-output');

if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
  console.error('Set PRIMEPROP_BASE_URL to the deployed HTTPS application origin.');
  process.exit(2);
}
if (!bearer) {
  console.error('Set PRIMEPROP_ADMIN_BEARER to a current administrator access token.');
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
