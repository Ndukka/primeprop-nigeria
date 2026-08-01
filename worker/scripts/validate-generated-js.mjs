import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryDir = path.resolve(scriptDir, '..', '..');
const outputDir = path.join(repositoryDir, 'dist-public');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }

  return files.sort();
}

function syntaxContext(error, source, relative) {
  const stack = error instanceof Error ? String(error.stack || '') : '';
  const escaped = relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const location = stack.match(new RegExp(`${escaped}:(\\d+)(?::(\\d+))?`));
  const lineNumber = Number(location?.[1] || 0);
  const columnNumber = Number(location?.[2] || 0);
  const lines = source.split('\n');
  const start = Math.max(0, lineNumber - 2);
  const end = Math.min(lines.length, lineNumber + 1);

  return {
    line: lineNumber || null,
    column: columnNumber || null,
    excerpt: lineNumber > 0
      ? lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n')
      : source.slice(0, 600),
    stack: stack.split('\n').slice(0, 5).join('\n'),
  };
}

const files = await walk(outputDir);
const failures = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const relative = path.relative(repositoryDir, file).split(path.sep).join('/');

  try {
    new Script(source, { filename: relative });
  } catch (error) {
    failures.push({
      file: relative,
      message: error instanceof Error ? error.message : String(error),
      ...syntaxContext(error, source, relative),
    });
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({
    event: 'generated_javascript_validation_failed',
    checked: files.length,
    failures,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  event: 'generated_javascript_validation_passed',
  checked: files.length,
}));
