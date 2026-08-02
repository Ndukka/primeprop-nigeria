import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKER_DIR = resolve(__dirname, '..');
const REPOSITORY_DIR = resolve(WORKER_DIR, '..');
const DIST_DIR = resolve(REPOSITORY_DIR, 'dist-public');

function readDist(relativePath: string): string {
  return readFileSync(resolve(DIST_DIR, relativePath), 'utf8');
}

const manifest = JSON.parse(
  readDist('asset-manifest.json'),
) as { assets: Record<string, string> };

function generatedSource(sourcePath: string): string {
  const generatedPath = manifest.assets[sourcePath];
  expect(generatedPath, `${sourcePath} must be emitted`).toBeTruthy();
  return readDist(generatedPath.replace(/^\//, ''));
}

describe('administrator inventory browser regressions', () => {
  it('uses authenticated uncached inventory endpoints', () => {
    const source = generatedSource('js/admin-data.js');

    expect(source).toContain("client.requestJson('/auth/admin-districts'");
    expect(source).toContain("client.requestJson('/auth/admin-users'");
    expect(source).not.toContain("client.requestJson('/api/districts'");
    expect(source).not.toContain("client.requestJson('/auth/users'");
  });

  it('renders districts and users without legacy loader delegation', () => {
    const source = generatedSource('js/admin-data.js');

    expect(source).toContain('window.renderDistrictsTable = function renderDistrictsTable()');
    expect(source).toContain('window.renderUsersTable = function renderUsersTable()');
    expect(source).toContain('No districts are stored in the database.');
    expect(source).toContain('No users are stored in the database.');
    expect(source).not.toContain('originalLoadUsersData');
    expect(source).not.toContain('interceptedApiFetch');
  });

  it('preserves the existing administrative action functions', () => {
    const source = generatedSource('js/admin-data.js');

    for (const action of [
      'window.openDistrictModal',
      'window.confirmDeleteDistrict',
      'window.banUser',
      'window.unbanUser',
      'window.openUserModal',
      'window.deleteUser',
    ]) {
      expect(source).toContain(action);
    }
  });

  it('loads the narrow admin compatibility runtime after the main adapter', () => {
    const html = readDist('admin.html');
    const dataUrl = manifest.assets['js/admin-data.js'];
    const compatUrl = manifest.assets['js/admin-compat.js'];

    expect(dataUrl).toBeTruthy();
    expect(compatUrl).toBeTruthy();
    expect(html.indexOf(`src="${dataUrl}"`)).toBeGreaterThan(-1);
    expect(html.indexOf(`src="${compatUrl}"`)).toBeGreaterThan(html.indexOf(`src="${dataUrl}"`));

    const compat = generatedSource('js/admin-compat.js');
    expect(compat).toContain("value.startsWith('/api/images/')");
    expect(compat).toContain("option[value=\"user\"]");
    expect(compat).toContain('email.disabled = Boolean(id)');
    expect(compat).toContain('/auth/admin-users/${encodeURIComponent(id)}');
    expect(compat).toContain("body: JSON.stringify({ account_status: accountStatus })");
    expect(compat).toContain('await window.loadUsersData()');
  });
});

describe('public and agent data-action regressions', () => {
  it('routes public district guides through a stable camelCase endpoint', () => {
    const catalogue = generatedSource('js/catalog-data.js');

    expect(catalogue).toContain("client.requestJson('/auth/district-guides'");
    expect(catalogue).toContain("district.linkType === 'sale'");
    expect(catalogue).toContain("district.linkType === 'rent'");
    expect(catalogue).toContain("district.linkType === 'land'");
  });

  it('repairs card and detail contact actions with same-origin redirects', () => {
    const catalogue = generatedSource('js/catalog-data.js');

    expect(catalogue).toContain('applyContactRoutes');
    expect(catalogue).toContain('/auth/listing-contact/${encodeURIComponent(id)}/whatsapp');
    expect(catalogue).toContain('/auth/listing-contact/${encodeURIComponent(id)}/call');
    expect(catalogue).toContain('RETIRED_CONTACT');
  });

  it('routes agent deletes through ownership-aware endpoints', () => {
    const agent = generatedSource('js/agent-data.js');

    expect(agent).toContain("['PUT', 'DELETE'].includes(method)");
    expect(agent).toContain("'/auth/listing-records/'");
    expect(agent).toContain("value.startsWith('/api/images/')");
    expect(agent).toContain('window.isSafeUrl = safeMediaUrl');
  });
});
