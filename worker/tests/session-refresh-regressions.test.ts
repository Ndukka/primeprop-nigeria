import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HARDENED_ENTRY = resolve(__dirname, '../src/hardened-entry.ts');
const INVALIDATION_MIGRATION = resolve(
  __dirname,
  '../migrations/0020_security_stamp_invalidation_timestamp.sql',
);

function source(): string {
  return readFileSync(HARDENED_ENTRY, 'utf-8');
}

describe('session refresh race source contract', () => {
  it('distinguishes an immediate same-browser duplicate from a delayed replay', () => {
    const hardened = source();

    expect(hardened).toContain('const REFRESH_REUSE_GRACE_MS = 15 * 1000');
    expect(hardened).toContain('function isRecentSameClientRotation');
    expect(hardened).toContain('session.ip_address === fingerprint.ip');
    expect(hardened).toContain('session.user_agent === fingerprint.userAgent');
    expect(hardened).toContain('age > REFRESH_REUSE_GRACE_MS');
  });

  it('renews only the access cookie during the grace path', () => {
    const hardened = source();
    const graceStart = hardened.indexOf('if (isRecentSameClientRotation(request, session))');
    const strictReplayStart = hardened.indexOf("await env.DB.batch([", graceStart);
    const graceBlock = hardened.slice(graceStart, strictReplayStart);

    expect(graceStart).toBeGreaterThan(-1);
    expect(strictReplayStart).toBeGreaterThan(graceStart);
    expect(graceBlock).toContain('replaceAccessCookie(request, access.token)');
    expect(graceBlock).toContain('setCookies: [accessCookie(access.token)]');
    expect(graceBlock).not.toContain('pp_refresh=');
    expect(graceBlock).not.toContain('clearedAuthCookies');
  });

  it('retains family revocation for a replay outside the grace path', () => {
    const hardened = source();

    expect(hardened).toContain("UPDATE sessions SET revoked = 1 WHERE token_family = ?");
    expect(hardened).toContain("Session reuse was detected. Please sign in again.");
    expect(hardened).toContain("UPDATE users SET security_stamp = ? WHERE id = ?");
  });

  it('advances the access-token invalidation timestamp for every security-stamp change', () => {
    const migration = readFileSync(INVALIDATION_MIGRATION, 'utf-8');

    expect(migration).toContain('AFTER UPDATE OF security_stamp ON users');
    expect(migration).toContain('WHEN NEW.security_stamp IS NOT OLD.security_stamp');
    expect(migration).toContain('SET security_stamp_changed_at =');
    expect(migration).toContain("strftime('%s', 'now')");
    expect(migration).toContain("strftime('%f', 'now')");
  });
});
