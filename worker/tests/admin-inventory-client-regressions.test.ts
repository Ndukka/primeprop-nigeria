import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKER_DIR = resolve(__dirname, '..');
const REPOSITORY_DIR = resolve(WORKER_DIR, '..');
const DIST_DIR = resolve(REPOSITORY_DIR, 'dist-public');

const manifest = JSON.parse(
  readFileSync(resolve(DIST_DIR, 'asset-manifest.json'), 'utf8'),
) as { assets: Record<string, string> };

function generatedSource(sourcePath: string): string {
  const generatedPath = manifest.assets[sourcePath];
  expect(generatedPath, `${sourcePath} must be emitted`).toBeTruthy();
  return readFileSync(resolve(DIST_DIR, generatedPath.replace(/^\//, '')), 'utf8');
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
});
