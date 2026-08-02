import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '..', '..');
const outputDirectory = path.join(repositoryDirectory, 'dist-public');
const manifestPath = path.join(outputDirectory, 'asset-manifest.json');

const DYNAMIC_RUNTIME_SOURCES = [
  'js/feedback-client.js',
  'js/listing-feedback.js',
  'js/agent-feedback.js',
  'js/admin-feedback.js',
];

function shortHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function absoluteOutputPath(urlPath) {
  return path.join(outputDirectory, String(urlPath).replace(/^\//, ''));
}

function clientDataAssetPath(content) {
  return `/assets/js/client-data.${shortHash(content)}.js`;
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const oldClientDataUrl = manifest.assets?.['js/client-data.js'];
if (!oldClientDataUrl) {
  throw new Error('The generated manifest does not contain js/client-data.js.');
}

let clientData = await readFile(absoluteOutputPath(oldClientDataUrl), 'utf8');
const replacements = [];

for (const sourcePath of DYNAMIC_RUNTIME_SOURCES) {
  const hashedUrl = manifest.assets?.[sourcePath];
  if (!hashedUrl || !/^\/assets\/.+\.[a-f0-9]{12}\.js$/i.test(hashedUrl)) {
    throw new Error(`The generated manifest does not contain a hashed URL for ${sourcePath}.`);
  }

  const stableUrl = `/${sourcePath}`;
  if (!clientData.includes(stableUrl)) {
    throw new Error(`The generated client runtime does not contain the expected dynamic URL ${stableUrl}.`);
  }

  clientData = clientData.replaceAll(stableUrl, hashedUrl);
  replacements.push({ sourcePath, stableUrl, hashedUrl });
}

for (const { stableUrl } of replacements) {
  if (clientData.includes(stableUrl)) {
    throw new Error(`An unversioned runtime URL remains after replacement: ${stableUrl}`);
  }
}

const newClientDataUrl = clientDataAssetPath(clientData);
const newClientDataPath = absoluteOutputPath(newClientDataUrl);
await mkdir(path.dirname(newClientDataPath), { recursive: true });
await writeFile(newClientDataPath, clientData, 'utf8');

if (newClientDataUrl !== oldClientDataUrl) {
  await rm(absoluteOutputPath(oldClientDataUrl), { force: true });
}
manifest.assets['js/client-data.js'] = newClientDataUrl;

let rewrittenPages = 0;
for (const page of manifest.pages || []) {
  const relativePath = String(page.relativePath || '');
  if (!relativePath) continue;

  const pagePath = path.join(outputDirectory, relativePath);
  let html = await readFile(pagePath, 'utf8');
  if (!html.includes(oldClientDataUrl)) {
    throw new Error(`${relativePath} does not reference the generated client-data asset.`);
  }

  html = html.replaceAll(oldClientDataUrl, newClientDataUrl);
  const buildId = shortHash(html);
  if (!/<meta\s+name=["']primeprop-build["'][^>]*>/i.test(html)) {
    throw new Error(`${relativePath} does not contain a primeprop-build marker.`);
  }
  html = html.replace(
    /<meta\s+name=["']primeprop-build["'][^>]*>/i,
    `<meta name="primeprop-build" content="${buildId}">`,
  );
  page.buildId = buildId;
  await writeFile(pagePath, html, 'utf8');
  rewrittenPages += 1;
}

const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const temporaryManifestPath = `${manifestPath}.tmp`;
await writeFile(temporaryManifestPath, manifestText, 'utf8');
await rename(temporaryManifestPath, manifestPath);

console.log(JSON.stringify({
  event: 'dynamic_runtime_assets_versioned',
  clientData: newClientDataUrl,
  runtimes: replacements.length,
  pages: rewrittenPages,
  manifestHash: shortHash(manifestText),
}));
