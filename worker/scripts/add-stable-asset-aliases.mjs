import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryDir = path.resolve(scriptDir, '..', '..');
const outputDir = path.join(repositoryDir, 'dist-public');
const manifestPath = path.join(outputDir, 'asset-manifest.json');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
let aliases = 0;

for (const [sourcePath, hashedUrl] of Object.entries(manifest.assets || {})) {
  if (!/\.(?:css|js)$/i.test(sourcePath)) continue;
  if (sourcePath === 'csp-compat.css' || sourcePath === 'js/csp-events.js') continue;

  const source = path.join(outputDir, String(hashedUrl).replace(/^\//, ''));
  const destination = path.join(outputDir, sourcePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  aliases += 1;
}

console.log(JSON.stringify({ event: 'stable_asset_aliases_created', aliases }));
