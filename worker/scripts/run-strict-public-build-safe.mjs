import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, '..');
const repositoryDir = path.resolve(workerDir, '..');
const strictBuildPath = path.join(scriptDir, 'run-strict-public-build.mjs');

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
];

function toCamelCase(property) {
  return property.trim().replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
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

const originals = new Map();
let result;
let expandedCssTextAssignments = 0;

try {
  for (const patch of SOURCE_PATCHES) {
    const absolutePath = path.join(repositoryDir, patch.relativePath);
    const original = await readFile(absolutePath, 'utf8');
    let prepared = applyRequiredReplacements(original, patch.relativePath, patch.replacements);

    if (patch.expandCssText) {
      const expansion = expandStaticCssTextAssignments(prepared, patch.relativePath);
      prepared = expansion.prepared;
      expandedCssTextAssignments += expansion.count;
    }

    originals.set(absolutePath, original);
    await writeFile(absolutePath, prepared, 'utf8');
  }

  console.log(JSON.stringify({
    event: 'strict_source_normalization_completed',
    files: SOURCE_PATCHES.length,
    expandedCssTextAssignments,
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
