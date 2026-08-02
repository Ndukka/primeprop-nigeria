import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const entry = readFileSync(resolve(__dirname, '../src/professional-session-entry.ts'), 'utf-8');
const wrangler = readFileSync(resolve(__dirname, '../wrangler.toml'), 'utf-8');
const errors = readFileSync(resolve(__dirname, '../../errors.md'), 'utf-8');
const incident = readFileSync(
  resolve(__dirname, '../../docs/errors/PP-ERR-051-transient-dashboard-permission-refresh.md'),
  'utf-8',
);

describe('professional dashboard session preflight', () => {
  it('is the deployed Worker entry and delegates to the established production boundary', () => {
    expect(wrangler).toContain('main = "src/professional-session-entry.ts"');
    expect(entry).toContain("import productionWorker, { RateLimiter } from './production-entry'");
    expect(entry).toContain('return productionWorker.fetch(request, env, ctx)');
  });

  it('covers current administrator and agent dashboard routes', () => {
    for (const route of [
      '/auth/admin-',
      '/auth/feedback/admin/',
      '/auth/security/',
      '/auth/profile-settings',
      '/auth/my-listings',
      '/auth/listing-records',
      '/auth/register',
      '/auth/users',
      '/auth/profile',
      '/auth/logout',
      '/api/uploads',
      '/api/images/upload',
    ]) {
      expect(entry).toContain(route);
    }
    expect(entry).toContain("path.startsWith('/api/') && !SAFE_METHODS.has(method.toUpperCase())");
  });

  it('does not intercept the public session endpoint or public reviewer routes', () => {
    expect(entry).toContain("if (path === '/auth/session') return false");
    expect(entry).not.toContain("'/auth/feedback/ratings'");
    expect(entry).not.toContain("'/auth/feedback/reports'");
    expect(entry).not.toContain("'/auth/feedback/session'");
  });

  it('refreshes through the hardened session route and forwards renewed CSRF state', () => {
    expect(entry).toContain("new URL('/auth/session', request.url)");
    expect(entry).toContain('refreshedRequest(request, cookies)');
    expect(entry).toContain("headers.set('X-CSRF-Token', refreshedCsrf)");
    expect(entry).toContain('appendSetCookies(response, cookies)');
    expect(entry).not.toContain('Insufficient permissions. This action requires: admin');
  });

  it('keeps the permanent error bank synchronized with the incident record', () => {
    expect(errors).toContain('## PP-ERR-049:');
    expect(errors).toContain('## PP-ERR-050:');
    expect(errors).toContain('## PP-ERR-051:');
    expect(incident).toContain('/auth/admin-districts');
    expect(incident).toContain('/auth/profile-settings');
    expect(incident).toContain('dbUser.role');
  });
});
