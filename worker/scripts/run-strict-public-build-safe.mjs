import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, '..');
const repositoryDir = path.resolve(workerDir, '..');
const strictBuildPath = path.join(scriptDir, 'run-strict-public-build.mjs');

const ICON_STYLE_REPLACEMENT = [
  "icon.style.fontSize = '1.5rem';",
  "          icon.style.color = '#64748b';",
  "          icon.style.position = 'absolute';",
  "          icon.style.top = '50%';",
  "          icon.style.left = '50%';",
  "          icon.style.transform = 'translate(-50%,-50%)';",
].join('\n');

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
      [
        "icon.style.cssText = 'font-size:1.5rem;color:#64748b;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)';",
        ICON_STYLE_REPLACEMENT,
      ],
    ],
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
      [
        "icon.style.cssText = 'font-size:1.5rem;color:#64748b;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)';",
        ICON_STYLE_REPLACEMENT,
      ],
    ],
  },
];

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

try {
  for (const patch of SOURCE_PATCHES) {
    const absolutePath = path.join(repositoryDir, patch.relativePath);
    const original = await readFile(absolutePath, 'utf8');
    const prepared = applyRequiredReplacements(original, patch.relativePath, patch.replacements);
    originals.set(absolutePath, original);
    await writeFile(absolutePath, prepared, 'utf8');
  }

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
