import { spawnSync } from 'node:child_process';
import {
  cp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, '..');
const repositoryDir = path.resolve(workerDir, '..');
const publicDir = path.join(repositoryDir, 'public');
const preparedDir = path.join(repositoryDir, '.strict-public-source');
const backupDir = path.join(repositoryDir, '.public-source-backup');
const appPath = path.join(preparedDir, 'js', 'app.js');

function replaceRequired(source, pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) {
    throw new Error(`Strict source preparation could not find ${label}`);
  }
  return next;
}

async function walkTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkTextFiles(absolute));
    else if (/\.(?:html|js)$/i.test(entry.name)) files.push(absolute);
  }
  return files;
}

function convertStyleAttributes(source) {
  return source
    .replace(/\bstyle="([^"]*)"/g, 'data-pp-css="$1"')
    .replace(/\bstyle='([^']*)'/g, 'data-pp-css="$1"')
    .replace(/\bstyle=\\"([^"\\]*(?:\\.[^"\\]*)*)\\"/g, 'data-pp-css=\\"$1\\"')
    .replace(/\bstyle=\\'([^'\\]*(?:\\.[^'\\]*)*)\\'/g, 'data-pp-css=\\"$1\\"');
}

async function prepareSource() {
  await rm(preparedDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await cp(publicDir, preparedDir, { recursive: true });

  let app = await readFile(appPath, 'utf8');

  // Replace JavaScript-generated inline lightbox handlers with declarative data.
  // The strict runtime attaches direct listeners to these elements.
  app = replaceRequired(
    app,
    /onclick="openLightbox\(\$\{JSON\.stringify\(imageUrls\)\.replace\(\/"\/g,'&quot;'\)\}, \$\{i\}\)"/g,
    'data-pp-action="lightbox" data-pp-images="${JSON.stringify(imageUrls).replace(/"/g,\'&quot;\')}" data-pp-index="${i}"',
    'multi-image lightbox markup',
  );

  app = replaceRequired(
    app,
    /onclick="openLightbox\(\$\{JSON\.stringify\(imageUrls\)\.replace\(\/"\/g,'&quot;'\)\}, 0\)"/g,
    'data-pp-action="lightbox" data-pp-images="${JSON.stringify(imageUrls).replace(/"/g,\'&quot;\')}" data-pp-index="0"',
    'single-image lightbox markup',
  );
  await writeFile(appPath, app, 'utf8');

  const files = await walkTextFiles(preparedDir);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const prepared = convertStyleAttributes(source);
    const remaining = prepared.match(/\sstyle\s*=\s*(?:\\?["'])/i);
    if (remaining) {
      const index = remaining.index || 0;
      const context = prepared.slice(Math.max(0, index - 100), index + 240);
      throw new Error(`${path.relative(preparedDir, file)} retains a style attribute: ${context}`);
    }
    await writeFile(file, prepared, 'utf8');
  }

  const preparedApp = await readFile(appPath, 'utf8');
  if (/onclick="openLightbox\(/.test(preparedApp)) {
    throw new Error('An inline lightbox handler remains after strict source preparation');
  }
}

async function restoreSource() {
  await rm(publicDir, { recursive: true, force: true });
  await rename(backupDir, publicDir);
  await rm(preparedDir, { recursive: true, force: true });
}

await prepareSource();
await rename(publicDir, backupDir);
await rename(preparedDir, publicDir);

try {
  const result = spawnSync(process.execPath, [path.join(scriptDir, 'build-public.mjs')], {
    cwd: workerDir,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await restoreSource();
}
