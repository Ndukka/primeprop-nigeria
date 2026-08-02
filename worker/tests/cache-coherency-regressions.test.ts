import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(currentDirectory, '..');
const repositoryDirectory = resolve(workerDirectory, '..');
const distPublic = resolve(repositoryDirectory, 'dist-public');

function source(relativePath: string): string {
  return readFileSync(resolve(repositoryDirectory, relativePath), 'utf8');
}

function built(relativePath: string): string {
  return readFileSync(resolve(distPublic, relativePath.replace(/^\//, '')), 'utf8');
}

type Manifest = {
  assets: Record<string, string>;
  pages: Array<{ relativePath: string; buildId: string }>;
};

function manifest(): Manifest {
  return JSON.parse(built('asset-manifest.json')) as Manifest;
}

const dynamicRuntimeSources = [
  'js/feedback-client.js',
  'js/listing-feedback.js',
  'js/agent-feedback.js',
  'js/admin-feedback.js',
];

describe('cache coherency contracts', () => {
  it('versions every dynamically loaded feedback runtime in generated client data', () => {
    const generated = manifest();
    const clientDataUrl = generated.assets['js/client-data.js'];

    expect(clientDataUrl).toMatch(/^\/assets\/js\/client-data\.[a-f0-9]{12}\.js$/i);
    const clientData = built(clientDataUrl);

    for (const runtimeSource of dynamicRuntimeSources) {
      const hashedUrl = generated.assets[runtimeSource];
      expect(hashedUrl, `${runtimeSource} must exist in the manifest`).toMatch(
        /^\/assets\/.+\.[a-f0-9]{12}\.js$/i,
      );
      expect(clientData).toContain(hashedUrl);
      expect(clientData).not.toContain(`/${runtimeSource}`);
    }
  });

  it('keeps all deployable page script references content hashed', () => {
    const generated = manifest();

    for (const page of generated.pages) {
      const html = built(page.relativePath);
      const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
        .map(match => match[1]);

      expect(scripts.length, `${page.relativePath} must load JavaScript`).toBeGreaterThan(0);
      for (const script of scripts) {
        expect(script, `${page.relativePath} contains an unversioned script`).toMatch(
          /^\/assets\/.+\.[a-f0-9]{12}\.js$/i,
        );
      }
      expect(html).toContain(`name="primeprop-build" content="${page.buildId}"`);
    }
  });

  it('runs dynamic versioning before mutable compatibility aliases are copied', () => {
    const packageJson = JSON.parse(source('worker/package.json')) as {
      scripts: Record<string, string>;
    };
    const buildCommand = packageJson.scripts['build:public'];

    expect(buildCommand).toContain('version-dynamic-runtime-assets.mjs');
    expect(buildCommand.indexOf('version-dynamic-runtime-assets.mjs')).toBeLessThan(
      buildCommand.indexOf('add-stable-asset-aliases.mjs'),
    );
    expect(packageJson.scripts['check:operator-scripts']).toContain(
      'version-dynamic-runtime-assets.mjs',
    );
  });

  it('records both recent production incidents in the permanent error bank', () => {
    const errors = source('errors.md');

    expect(errors).toContain('PP-ERR-045');
    expect(errors).toContain('incomplete input: SQLITE_ERROR');
    expect(errors).toContain('release:production:verified');
    expect(errors).toContain('PP-ERR-046');
    expect(errors).toContain('unversioned dynamically loaded feedback scripts');
    expect(errors).toContain('version-dynamic-runtime-assets.mjs');
  });
});
