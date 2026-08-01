import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, '..');
const repositoryDir = path.resolve(workerDir, '..');
const publicDir = path.join(repositoryDir, 'public');
const strictBuildPath = path.join(scriptDir, 'run-strict-public-build.mjs');

const KNOWN_PAGE_FILENAMES = [
  'index.html',
  'properties.html',
  'properties-rent.html',
  'properties-sale.html',
  'properties-land.html',
  'areas.html',
  'listing-detail.html',
  'listing-detail-1.html',
  'listing-detail-2.html',
  'listing-detail-3.html',
  'login.html',
  'admin.html',
  'agent.html',
  'reset-password.html',
];

const SOURCE_PATCHES = [
  {
    relativePath: 'public/login.html',
    replacements: [
      [
        "function showSignup() { document.getElementById('loginCard').style.display = 'none'; document.getElementById('signupCard').style.display = 'block'; }",
        [
          'function showSignup() {',
          "      document.getElementById('loginCard').style.display = 'none';",
          "      document.getElementById('signupCard').style.display = 'block';",
          '    }',
        ].join('\n'),
      ],
      [
        "function showLogin() { document.getElementById('signupCard').style.display = 'none'; document.getElementById('loginCard').style.display = 'block'; }",
        [
          'function showLogin() {',
          "      document.getElementById('signupCard').style.display = 'none';",
          "      document.getElementById('loginCard').style.display = 'block';",
          '    }',
        ].join('\n'),
      ],
    ],
    expandCssText: false,
  },
  {
    relativePath: 'public/admin.html',
    replacements: [
      [
        "img.onerror = function() { this.style.display = 'none'; };",
        [
          "img.addEventListener('error', function() {",
          "        this.style.display = 'none';",
          '      });',
        ].join('\n'),
      ],
    ],
    expandCssText: true,
  },
  {
    relativePath: 'public/agent.html',
    replacements: [
      [
        "img.onerror = function() { this.style.display = 'none'; };",
        [
          "img.addEventListener('error', function() {",
          "        this.style.display = 'none';",
          '      });',
        ].join('\n'),
      ],
    ],
    expandCssText: true,
  },
  {
    relativePath: 'public/js/strict-runtime.js',
    replacements: [
      [
        [
          '    showPageSkeleton();',
          '    requestAnimationFrame(() => {',
          '      window.location.assign(url.href);',
          '    });',
        ].join('\n'),
        '    window.location.assign(url.href);',
      ],
    ],
    expandCssText: false,
  },
];

const PATCHES_BY_PATH = new Map(SOURCE_PATCHES.map(patch => [patch.relativePath, patch]));

function toCamelCase(property) {
  return property.trim().replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeQuotedRootAbsolutePageReferences(source) {
  let prepared = source;
  let count = 0;

  for (const filename of KNOWN_PAGE_FILENAMES) {
    const pattern = new RegExp(`(["'\\x60])/${escapeRegExp(filename)}(?=([?#][^"'\\x60\\s<>]*)?\\1)`, 'g');
    prepared = prepared.replace(pattern, (_match, quote) => {
      count += 1;
      return `${quote}${filename}`;
    });
  }

  return { prepared, count };
}

function expandStaticCssTextAssignments(source, relativePath) {
  const pattern = /^(\s*)([A-Za-z_$][\w$]*)\.style\.cssText\s*=\s*(['"])(.*?)\3;/gm;
  let count = 0;

  const prepared = source.replace(pattern, (_match, indentation, target, _quote, cssText) => {
    const declarations = cssText
      .split(';')
      .map(declaration => declaration.trim())
      .filter(Boolean)
      .map(declaration => {
        const separator = declaration.indexOf(':');
        if (separator <= 0) {
          throw new Error(`${relativePath}: invalid static cssText declaration: ${declaration}`);
        }
        return {
          property: toCamelCase(declaration.slice(0, separator)),
          value: declaration.slice(separator + 1).trim(),
        };
      });

    if (declarations.length === 0) {
      throw new Error(`${relativePath}: empty static cssText assignment.`);
    }

    count += 1;
    return declarations
      .map(({ property, value }) => `${indentation}${target}.style.${property} = ${JSON.stringify(value)};`)
      .join('\n');
  });

  if (/\.style\.cssText\s*=/.test(prepared)) {
    throw new Error(`${relativePath}: unsupported cssText assignment remains after normalization.`);
  }

  return { prepared, count };
}

function applyRequiredReplacements(source, relativePath, replacements) {
  let prepared = source;

  for (const [original, replacement] of replacements) {
    const firstIndex = prepared.indexOf(original);
    const lastIndex = prepared.lastIndexOf(original);

    if (firstIndex < 0) {
      throw new Error(`${relativePath}: source normalization target was not found.`);
    }
    if (firstIndex !== lastIndex) {
      throw new Error(`${relativePath}: source normalization target is ambiguous.`);
    }

    prepared = prepared.replace(original, replacement);
  }

  return prepared;
}

async function walkTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkTextFiles(absolute));
    } else if (/\.(?:html|js)$/i.test(entry.name)) {
      files.push(absolute);
    }
  }

  return files.sort();
}

const originals = new Map();
const appliedPatches = new Set();
let result;
let expandedCssTextAssignments = 0;
let normalizedPageReferences = 0;

try {
  const sourceFiles = await walkTextFiles(publicDir);

  for (const absolutePath of sourceFiles) {
    const relativePath = path.relative(repositoryDir, absolutePath).split(path.sep).join('/');
    const patch = PATCHES_BY_PATH.get(relativePath);
    const original = await readFile(absolutePath, 'utf8');
    let prepared = original;

    if (patch) {
      prepared = applyRequiredReplacements(prepared, relativePath, patch.replacements);
      appliedPatches.add(relativePath);

      if (patch.expandCssText) {
        const expansion = expandStaticCssTextAssignments(prepared, relativePath);
        prepared = expansion.prepared;
        expandedCssTextAssignments += expansion.count;
      }
    }

    const pageReferenceNormalization = normalizeQuotedRootAbsolutePageReferences(prepared);
    prepared = pageReferenceNormalization.prepared;
    normalizedPageReferences += pageReferenceNormalization.count;

    if (prepared === original) continue;
    originals.set(absolutePath, original);
    await writeFile(absolutePath, prepared, 'utf8');
  }

  for (const patch of SOURCE_PATCHES) {
    if (!appliedPatches.has(patch.relativePath)) {
      throw new Error(`${patch.relativePath}: configured source patch was not applied.`);
    }
  }

  console.log(JSON.stringify({
    event: 'strict_source_normalization_completed',
    files: originals.size,
    expandedCssTextAssignments,
    normalizedPageReferences,
    navigationOverlayDisabled: true,
  }));

  result = spawnSync(process.execPath, [strictBuildPath], {
    cwd: workerDir,
    stdio: 'inherit',
    env: process.env,
  });
} finally {
  for (const [absolutePath, original] of originals) {
    await writeFile(absolutePath, original, 'utf8');
  }
}

if (result?.error) throw result.error;
if (result?.status !== 0) process.exitCode = result?.status ?? 1;
