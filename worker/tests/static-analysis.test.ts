import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Static File Analysis Tests ─────────────────────────────
// These don't need a running Worker — they check source code for security patterns.

const PUBLIC = resolve(__dirname, '../../public');
const WORKER_SRC = resolve(__dirname, '../src');

function readPublic(filename: string): string {
  return readFileSync(resolve(PUBLIC, filename), 'utf-8');
}

function readSrc(filename: string): string {
  return readFileSync(resolve(WORKER_SRC, filename), 'utf-8');
}

describe('PP-SEC-001: JWT Secret', () => {
  it('JWT_SECRET not committed in wrangler.toml', () => {
    const toml = readFileSync(resolve(__dirname, '../wrangler.toml'), 'utf-8');
    expect(toml).not.toContain('8ede7810ed2db72');
    expect(toml).not.toMatch(/JWT_SECRET\s*=\s*"[a-f0-9]{64}"/);
  });
});

describe('PP-SEC-002: XSS Prevention (Static)', () => {
  it('admin.html has no innerHTML assignments', () => {
    const html = readPublic('admin.html');
    expect(html).not.toMatch(/\.innerHTML\s*=/);
  });

  it('agent.html has no innerHTML assignments', () => {
    const html = readPublic('agent.html');
    expect(html).not.toMatch(/\.innerHTML\s*=/);
  });

  it('admin.html uses safe patterns', () => {
    const html = readPublic('admin.html');
    expect(html).toContain('textContent');
    expect(html).toContain('createElement');
    expect(html).toContain('addEventListener');
  });

  it('agent.html uses safe patterns', () => {
    const html = readPublic('agent.html');
    expect(html).toContain('textContent');
    expect(html).toContain('createElement');
    expect(html).toContain('addEventListener');
  });
});

describe('PP-SEC-003: No LocalStorage Tokens', () => {
  it('login.html has no localStorage token set', () => {
    const html = readPublic('login.html');
    expect(html).not.toMatch(/localStorage\.setItem\(['"]pp_token['"]/);
    expect(html).not.toMatch(/localStorage\.getItem\(['"]pp_token['"]/);
  });

  it('admin.html has no localStorage token set', () => {
    const html = readPublic('admin.html');
    expect(html).not.toMatch(/localStorage\.setItem\(['"]pp_token['"]/);
    expect(html).not.toMatch(/localStorage\.getItem\(['"]pp_token['"]/);
  });

  it('agent.html uses cookie-based auth', () => {
    const html = readPublic('agent.html');
    expect(html).toContain('function getCsrf()');
    expect(html).toContain("credentials: 'include'");
  });
});

describe('PP-SEC-007: Admin Credentials Not in Migrations', () => {
  it('0001 has no admin INSERT', () => {
    const migration = readFileSync(resolve(__dirname, '../migrations/0001_initial.sql'), 'utf-8');
    expect(migration).not.toContain('admin@primeprop.ng');
  });

  it('0002 has no admin UPDATE', () => {
    const migration = readFileSync(resolve(__dirname, '../migrations/0002_fix_admin.sql'), 'utf-8');
    expect(migration).not.toContain('password_hash');
  });
});

describe('PP-SEC-009: Public Asset Directory', () => {
  it('public/ directory exists with HTML files', () => {
    const html = readPublic('index.html');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('sensitive files NOT in public/', () => {
    // These files should exist at root level but NOT be accessible from public/
    expect(() => readFileSync(resolve(PUBLIC, 'package.json'), 'utf-8')).toThrow();
    expect(() => readFileSync(resolve(PUBLIC, 'wrangler.toml'), 'utf-8')).toThrow();
    expect(() => readFileSync(resolve(PUBLIC, '.gitignore'), 'utf-8')).toThrow();
  });

  it('wrangler.toml points to ../public', () => {
    const toml = readFileSync(resolve(__dirname, '../wrangler.toml'), 'utf-8');
    expect(toml).toContain('directory = "../public"');
  });
});

describe('PP-SEC-027: DB Indexes', () => {
  it('0011_indexes.sql exists with indexes', () => {
    const migration = readFileSync(resolve(__dirname, '../migrations/0011_indexes.sql'), 'utf-8');
    expect(migration).toContain('idx_listings_created_by');
    expect(migration).toContain('idx_listings_type_city');
    expect(migration).toContain('idx_sessions_expires_revoked');
  });
});

describe('PP-SEC-038: SRI on CDN Assets', () => {
  const htmlFiles = ['admin.html', 'agent.html', 'login.html', 'index.html',
    'properties.html', 'areas.html', 'listing-detail.html'];

  for (const file of htmlFiles) {
    it(`${file} has SRI on Font Awesome`, () => {
      const html = readPublic(file);
      expect(html).toContain('integrity="sha384-');
      expect(html).toContain('crossorigin="anonymous"');
    });
  }
});

describe('PP-SEC-040: DO Alarm Cleanup', () => {
  it('rate-limiter.ts has alarm method', () => {
    const source = readSrc('rate-limiter.ts');
    expect(source).toContain('async alarm(');
    expect(source).toContain('setAlarm');
    expect(source).toContain('MAX_AGE_MS');
  });
});

describe('PP-SEC-044: Structured Logging', () => {
  it('logger module exists with required exports', () => {
    const source = readSrc('logger.ts');
    expect(source).toContain('generateRequestId');
    expect(source).toContain('createRequestLogger');
    expect(source).toContain('logSecurity');
    expect(source).toContain('Never log');
  });
});

describe('PP-SEC-042: No Obsolete Headers', () => {
  it('X-XSS-Protection not in index.ts', () => {
    const source = readSrc('index.ts');
    expect(source).not.toContain('X-XSS-Protection');
  });
});

describe('Security Module Integrity', () => {
  it('security-headers.ts exists', () => {
    const source = readSrc('security-headers.ts');
    expect(source).toContain('generateNonce');
    expect(source).toContain('buildCsp');
    expect(source).toContain("'strict-dynamic'");
  });

  it('file-validator.ts exists with magic byte checks', () => {
    const source = readSrc('file-validator.ts');
    expect(source).toContain('detectFileType');
    expect(source).toContain('validateFilename');
    expect(source).toContain('FF D8 FF'); // JPEG magic bytes
    expect(source).toContain('89 50 4E 47'); // PNG magic bytes
  });

  it('rate-limiter.ts exists as Durable Object', () => {
    const source = readSrc('rate-limiter.ts');
    expect(source).toContain('extends DurableObject');
    expect(source).toContain('checkLimit');
  });

  it('file-validator validates image headers', () => {
    const source = readSrc('file-validator.ts');
    expect(source).toContain('validateImageHeaders');
    expect(source).toContain('getSafeContentType');
    expect(source).toContain('requiresAttachmentDisposition');
  });
});
