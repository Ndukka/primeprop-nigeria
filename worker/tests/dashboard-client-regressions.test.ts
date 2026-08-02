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

describe('dashboard database, profile, and session regressions', () => {
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

  it('loads complete public and authenticated admin inventories', () => {
    const client = generatedSource('js/client-data.js');
    const admin = generatedSource('js/admin-data.js');
    const catalogue = generatedSource('js/catalog-data.js');

    expect(client).toContain('fetchPaginatedListings');
    expect(client).toContain("fetchPaginatedListings('/api/listings'");
    expect(client).toContain("fetchPaginatedListings('/auth/admin-listings'");
    expect(client).toContain("params.set('page', String(page))");
    expect(client).toContain('page <= totalPages');
    expect(admin).toContain('client.fetchAllAdminListings');
    expect(admin).toContain('filteredAdminListings');
    expect(admin).toContain('No listings match the selected filters.');
    expect(admin).toContain("client.requestJson('/auth/admin-districts'");
    expect(admin).toContain("client.requestJson('/auth/admin-users'");
    expect(catalogue).toContain('client.fetchAllListings(filters)');
  });

  it('distinguishes failed dashboard requests from genuinely empty database tables', () => {
    const admin = generatedSource('js/admin-data.js');
    const agent = generatedSource('js/agent-data.js');

    expect(admin).toContain('Promise.allSettled');
    expect(admin).toMatch(/client\.renderTableError\(\s*['"]tableBody['"]/);
    expect(admin).toMatch(/client\.renderTableError\(\s*['"]districtsTableBody['"]/);
    expect(admin).toMatch(/client\.renderTableError\(\s*['"]usersTableBody['"]/);
    expect(agent).toMatch(/client\.renderTableError\(\s*['"]tableBody['"]/);
    expect(admin).toContain('No districts are stored in the database.');
    expect(admin).toContain('No users are stored in the database.');
  });

  it('normalizes listing DTO fields for the agent editor', () => {
    const agent = generatedSource('js/agent-data.js');

    expect(agent).toContain('listing.propertyType');
    expect(agent).toContain('listing.priceUnit');
    expect(agent).toContain('property_type:');
    expect(agent).toContain('price_unit:');
  });

  it('routes browser listing writes through role-aware endpoints', () => {
    const admin = generatedSource('js/admin-data.js');
    const agent = generatedSource('js/agent-data.js');

    for (const source of [admin, agent]) {
      expect(source).toContain("return '/auth/listing-records'");
      expect(source).toContain("'/auth/listing-records/'");
      expect(source).toContain('roleAwareListingUrl');
    }
  });

  it('moves agent identity into one saved profile and disables listing overrides', () => {
    const agent = generatedSource('js/agent-data.js');

    expect(agent).toContain("client.requestJson('/auth/profile-settings'");
    expect(agent).toContain("method: 'PUT'");
    expect(agent).toContain('These details are saved to your account');
    expect(agent).toContain("'formAgentPhone'");
    expect(agent).toContain("'formAgentAvatar'");
    expect(agent).toContain("'formBadge'");
    expect(agent).toContain("'formFeatured'");
    expect(agent).toContain('control.disabled = true');
    expect(agent).toContain('group.hidden = true');
    expect(agent).toContain('Edit Profile');
    expect(agent).toContain("save.type = 'button'");
    expect(agent).toContain('if (saveButton?.disabled) return');
  });

  it('offers service apartments in admin, agent, and public property selectors', () => {
    const admin = generatedSource('js/admin-data.js');
    const agent = generatedSource('js/agent-data.js');
    const catalogue = generatedSource('js/catalog-data.js');

    for (const source of [admin, agent, catalogue]) {
      expect(source).toContain('service-apartment');
      expect(source).toContain('Service Apartment');
    }
  });

  it('routes wrong-role and expired sessions away from dashboards', () => {
    const admin = generatedSource('js/admin-data.js');
    const agent = generatedSource('js/agent-data.js');

    expect(admin).toContain("AUTH_USER.role !== 'admin'");
    expect(admin).toContain("window.location.replace('/agent')");
    expect(admin).toContain("window.location.replace('/login?reason=session-expired')");
    expect(agent).toContain("USER.role === 'admin'");
    expect(agent).toContain("window.location.replace('/admin')");
    expect(agent).toContain("window.location.replace('/login?reason=session-expired')");
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
