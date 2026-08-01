import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKER_DIR = resolve(__dirname, '..');
const REPOSITORY_DIR = resolve(WORKER_DIR, '..');
const DIST_DIR = resolve(REPOSITORY_DIR, 'dist-public');

function readDist(relativePath: string): string {
  return readFileSync(resolve(DIST_DIR, relativePath), 'utf8');
}

type Manifest = {
  assets: Record<string, string>;
};

const manifest = JSON.parse(readDist('asset-manifest.json')) as Manifest;

function generatedSource(sourcePath: string): string {
  const generatedPath = manifest.assets[sourcePath];
  expect(generatedPath, `${sourcePath} must be emitted`).toBeTruthy();
  return readDist(generatedPath.replace(/^\//, ''));
}

describe('dashboard database and session regressions', () => {
  it('ships the shared client runtime on admin and agent pages', () => {
    const admin = readDist('admin.html');
    const agent = readDist('agent.html');
    const sharedUrl = manifest.assets['js/client-data.js'];
    const adminUrl = manifest.assets['js/admin-data.js'];
    const agentUrl = manifest.assets['js/agent-data.js'];

    expect(sharedUrl).toBeTruthy();
    expect(adminUrl).toBeTruthy();
    expect(agentUrl).toBeTruthy();
    expect(admin).toContain(`src="${sharedUrl}"`);
    expect(admin).toContain(`src="${adminUrl}"`);
    expect(agent).toContain(`src="${sharedUrl}"`);
    expect(agent).toContain(`src="${agentUrl}"`);
  });

  it('performs logout with CSRF and redirects only after success', () => {
    const client = generatedSource('js/client-data.js');

    expect(client).toContain("fetch('/auth/logout'");
    expect(client).toContain("headers.set('X-CSRF-Token', csrf)");
    expect(client).toContain("window.location.replace('/login?loggedOut=1')");
    expect(client).not.toMatch(/finally\s*\([^)]*\/login/);
  });

  it('loads all listing pages instead of treating the first API page as the catalogue', () => {
    const client = generatedSource('js/client-data.js');
    const catalogue = generatedSource('js/catalog-data.js');

    expect(client).toContain("baseParams.set('limit', String(PAGE_SIZE))");
    expect(client).toContain("params.set('page', String(page))");
    expect(client).toContain('page <= totalPages');
    expect(catalogue).toContain('client.fetchAllListings(filters)');
    expect(catalogue).toContain('client.renderGridError');
  });

  it('distinguishes failed dashboard requests from genuinely empty database tables', () => {
    const admin = generatedSource('js/admin-data.js');
    const agent = generatedSource('js/agent-data.js');

    expect(admin).toContain('Promise.allSettled');
    expect(admin).toMatch(/client\.renderTableError\(\s*['"]tableBody['"]/);
    expect(admin).toMatch(/client\.renderTableError\(\s*['"]districtsTableBody['"]/);
    expect(admin).toMatch(/client\.renderTableError\(\s*['"]usersTableBody['"]/);
    expect(agent).toMatch(/client\.renderTableError\(\s*['"]tableBody['"]/);
    expect(admin).toContain("district.link_type || 'all'");
  });

  it('normalizes listing DTO fields for the agent editor', () => {
    const agent = generatedSource('js/agent-data.js');

    expect(agent).toContain('listing.propertyType');
    expect(agent).toContain('listing.priceUnit');
    expect(agent).toContain('property_type:');
    expect(agent).toContain('price_unit:');
  });

  it('routes non-admin sessions away from the admin dashboard', () => {
    const admin = generatedSource('js/admin-data.js');

    expect(admin).toContain("AUTH_USER.role !== 'admin'");
    expect(admin).toContain("window.location.replace('/agent')");
  });

  it('removes unsupported catalogue filters and implements four-or-more bedrooms', () => {
    const catalogue = generatedSource('js/catalog-data.js');
    const app = generatedSource('js/app.js');

    expect(catalogue).toContain("['shortlet', 'commercial']");
    expect(catalogue).toContain("terraced.value = 'terrace'");
    expect(catalogue).toContain("fourPlus.setAttribute('data-bedrooms', '4+')");
    expect(app).toContain("String(activeBedrooms).endsWith('+')");
  });

  it('replaces retired dummy contact actions without exposing private phone data', () => {
    const catalogue = generatedSource('js/catalog-data.js');

    expect(catalogue).toContain("const RETIRED_CONTACT = '2348000000000'");
    expect(catalogue).toContain('neutralizeRetiredContacts');
    expect(catalogue).toContain("label.textContent = 'Contact unavailable'");
    expect(catalogue).toContain('anchor.replaceWith(unavailableContactLabel())');
  });
});
