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

const SKELETON_MARKUP = [
  '<div class="pp-loading-skeleton" role="status" aria-label="Loading content">',
  '<span class="pp-loading-skeleton__line pp-loading-skeleton__line--wide"></span>',
  '<span class="pp-loading-skeleton__line"></span>',
  '<span class="pp-loading-skeleton__line pp-loading-skeleton__line--short"></span>',
  '<span class="pp-visually-hidden">Loading content</span>',
  '</div>',
].join('');

const SKELETON_STYLES = `
.pp-loading-skeleton{display:grid;gap:10px;width:min(100%,560px);margin:0 auto;padding:18px 20px}
.pp-loading-skeleton__line{display:block;height:12px;border-radius:999px;background:linear-gradient(90deg,#e2e8f0 25%,#f8fafc 50%,#e2e8f0 75%);background-size:200% 100%;animation:pp-skeleton-shimmer 1.2s ease-in-out infinite}
.pp-loading-skeleton__line--wide{height:18px;width:92%}
.pp-loading-skeleton__line--short{width:58%}
.pp-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
@keyframes pp-skeleton-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media(prefers-reduced-motion:reduce){.pp-loading-skeleton__line{animation:none;background:#e2e8f0}}
`;

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

function convertGeneratedStyleAttributes(source) {
  return source
    .replace(/\bstyle="([^"]*)"/g, 'data-pp-css="$1"')
    .replace(/\bstyle='([^']*)'/g, 'data-pp-css="$1"')
    .replace(/\bstyle=\\"([^"\\]*(?:\\.[^"\\]*)*)\\"/g, 'data-pp-css=\\"$1\\"')
    .replace(/\bstyle=\\'([^'\\]*(?:\\.[^'\\]*)*)\\'/g, 'data-pp-css=\\"$1\\"');
}

function convertEventPropertyAssignments(source) {
  const eventProperty = /(\b(?:this|document|window|[A-Za-z_$][\w$]*)(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[[^\]\n]+\])|(?:\([^;\n]*?\)))*?)\.on(click|error|submit|change|input|load)\s*=\s*([^;\n]+);/g;
  return source.replace(eventProperty, (_match, target, eventName, listener) => {
    return `window.PrimePropEvents.replace(${target}, '${eventName}', ${listener});`;
  });
}

function replaceLegacySpinnerMarkup(source) {
  return source
    .replace(
      /<div\b[^>]*\bclass=(['"])[^'"]*\bspinner\b[^'"]*\1[^>]*>\s*<\/div>/gi,
      SKELETON_MARKUP,
    )
    .replace(
      /<i\b[^>]*\bclass=(['"])[^'"]*\bfa-spinner\b[^'"]*\1[^>]*>\s*<\/i>/gi,
      SKELETON_MARKUP,
    );
}

function removeLegacySpinnerCss(source) {
  return source
    .replace(/\.spinner\s*\{[^}]*\}/gi, '')
    .replace(/@keyframes\s+spin\s*\{(?:[^{}]|\{[^{}]*\})*\}/gi, '');
}

function transformLegacyLoadingHtml(source) {
  let output = replaceLegacySpinnerMarkup(source);
  output = removeLegacySpinnerCss(output);

  if (output.includes('pp-loading-skeleton') && !output.includes('.pp-loading-skeleton{')) {
    output = output.replace('</head>', `<style>${SKELETON_STYLES}</style>\n</head>`);
  }
  return output;
}

function transformScriptSource(source) {
  return convertEventPropertyAssignments(
    convertGeneratedStyleAttributes(replaceLegacySpinnerMarkup(source)),
  );
}

function transformInlineScripts(html) {
  return html.replace(/(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi, (_match, opening, source, closing) => {
    return `${opening}${transformScriptSource(source)}${closing}`;
  });
}

function assertPreparedScriptSource(source, relativePath) {
  const eventProperty = source.match(/\.on(?:click|error|submit|change|input|load)\s*=/);
  if (eventProperty) {
    const index = eventProperty.index || 0;
    throw new Error(`${relativePath} retains an event property assignment: ${source.slice(Math.max(0, index - 100), index + 220)}`);
  }
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
    const relativePath = path.relative(preparedDir, file);
    const source = await readFile(file, 'utf8');
    let prepared;

    if (file.endsWith('.js')) {
      prepared = transformScriptSource(source);
      assertPreparedScriptSource(prepared, relativePath);
    } else {
      prepared = transformLegacyLoadingHtml(transformInlineScripts(source));
      const inlineSources = [...prepared.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
        .map(match => match[1]);
      for (const inlineSource of inlineSources) {
        assertPreparedScriptSource(inlineSource, relativePath);
      }
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