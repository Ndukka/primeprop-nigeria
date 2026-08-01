import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const SOURCE_PUBLIC = resolve(__dirname, '../../public');
const DIST_PUBLIC = resolve(__dirname, '../../dist-public');
const WORKER_SRC = resolve(__dirname, '../src');

function readSource(filename: string): string {
  return readFileSync(resolve(SOURCE_PUBLIC, filename), 'utf-8');
}

function readDist(filename: string): string {
  return readFileSync(resolve(DIST_PUBLIC, filename), 'utf-8');
}

function readSrc(filename: string): string {
  return readFileSync(resolve(WORKER_SRC, filename), 'utf-8');
}

function walk(directory: string, base = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute, base);
    return [absolute.slice(base.length + 1).replaceAll('\\', '/')];
  }).sort();
}

describe('credential and authentication source controls', () => {
  it('does not commit JWT_SECRET in Wrangler', () => {
    const toml = readFileSync(resolve(__dirname, '../wrangler.toml'), 'utf-8');
    expect(toml).not.toMatch(/JWT_SECRET\s*=\s*"[^"]+"/);
  });

  it('does not seed or document the retired administrator credential', () => {
    const initial = readFileSync(resolve(__dirname, '../migrations/0001_initial.sql'), 'utf-8');
    const retired = readFileSync(resolve(__dirname, '../migrations/0002_fix_admin.sql'), 'utf-8');
    const guide = readFileSync(resolve(__dirname, '../../API_GUIDE.md'), 'utf-8');
    expect(initial).not.toContain('admin@primeprop.ng');
    expect(retired).not.toContain('password_hash');
    expect(guide).not.toMatch(/admin@primeprop\.ng[\s\S]{0,200}(?:password|admin123)/i);
  });

  it('does not store browser tokens in localStorage', () => {
    for (const file of ['login.html', 'admin.html', 'agent.html']) {
      const html = readSource(file);
      expect(html).not.toMatch(/localStorage\.(?:setItem|getItem)\(['"]pp_token['"]/);
    }
  });
});

describe('generated deployment bundle', () => {
  const files = walk(DIST_PUBLIC);
  const htmlFiles = files.filter(file => extname(file) === '.html');
  const javascriptFiles = files.filter(file => extname(file) === '.js');

  it('builds every public page and a manifest', () => {
    expect(htmlFiles).toEqual(expect.arrayContaining([
      'index.html',
      'properties.html',
      'properties-rent.html',
      'properties-sale.html',
      'properties-land.html',
      'areas.html',
      'listing-detail.html',
      'listing-detail-1.html',
      'listing-detail-2.html',
      'listing-detail-3.html',
      'login.html',
      'admin.html',
      'agent.html',
      'reset-password.html',
    ]));
    expect(existsSync(resolve(DIST_PUBLIC, 'asset-manifest.json'))).toBe(true);
  });

  for (const file of htmlFiles) {
    it(`${file} contains no inline CSS, inline scripts, or event attributes`, () => {
      const html = readDist(file);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/<style\b/i);
      expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>/i);
      expect(html).toContain('name="primeprop-build"');
      expect(html).toMatch(/<script[^>]+src="\/assets\/js\/strict-runtime\.[a-f0-9]{12}\.js"/);
    });

    it(`${file} uses root-absolute local references`, () => {
      const html = readDist(file);
      const references = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)].map(match => match[1]);
      for (const reference of references) {
        if (/^(?:https?:|mailto:|tel:|data:|blob:|#)/i.test(reference)) continue;
        expect(reference.startsWith('/')).toBe(true);
      }
    });
  }

  for (const file of javascriptFiles) {
    it(`${file} contains no style-property assignments or inline-handler markup`, () => {
      const javascript = readDist(file);
      expect(javascript).not.toMatch(/\.style\s*(?:\.|\[|=)/);
      expect(javascript).not.toMatch(/\bon(?:click|error|submit|change|input|load)\s*=/i);
      expect(javascript).not.toMatch(/\bstyle\s*=\s*(?:\\?["'])/i);
      expect(javascript).not.toMatch(/\beval\s*\(|\bnew\s+Function\b/);
    });
  }

  it('does not deploy the temporary compatibility bridge', () => {
    expect(files).not.toContain('csp-compat.css');
    expect(files).not.toContain('js/csp-events.js');
  });

  it('uses content-hashed CSS and JavaScript assets', () => {
    const manifest = JSON.parse(readDist('asset-manifest.json')) as {
      assets: Record<string, string>;
      pages: Array<{ relativePath: string }>;
    };
    expect(manifest.pages.length).toBe(htmlFiles.length);
    for (const [source, output] of Object.entries(manifest.assets)) {
      if (!/\.(?:css|js)$/.test(source)) continue;
      expect(output).toMatch(/^\/assets\/.+\.[a-f0-9]{12}\.(?:css|js)$/);
    }
  });
});

describe('Wrangler static-asset routing', () => {
  it('deploys only dist-public with canonical clean URLs', () => {
    const toml = readFileSync(resolve(__dirname, '../wrangler.toml'), 'utf-8');
    expect(toml).toContain('directory = "../dist-public"');
    expect(toml).toContain('html_handling = "drop-trailing-slash"');
    expect(toml).toContain('run_worker_first = true');
  });
});

describe('security module integrity', () => {
  it('uses strict script and style attributes', () => {
    const source = readSrc('security-headers.ts');
    expect(source).toContain("script-src-attr 'none'");
    expect(source).toContain("style-src-attr 'none'");
    expect(source).not.toContain("style-src-attr 'unsafe-inline'");
    expect(source).not.toContain('csp-events.js');
    expect(source).not.toContain('csp-compat.css');
  });

  it('retains file signature validation, DO cleanup, and structured logging', () => {
    const validator = readSrc('file-validator.ts');
    const limiter = readSrc('rate-limiter.ts');
    const logger = readSrc('logger.ts');
    expect(validator).toContain('detectFileType');
    expect(validator).toContain('validateImageHeaders');
    expect(limiter).toContain('async alarm(');
    expect(limiter).toContain('setAlarm');
    expect(logger).toContain('generateRequestId');
    expect(logger).toContain('logSecurity');
  });

  it('retains database indexes and final-administrator safeguards', () => {
    const indexes = readFileSync(resolve(__dirname, '../migrations/0011_indexes.sql'), 'utf-8');
    const safety = readFileSync(resolve(__dirname, '../migrations/0012_account_safety.sql'), 'utf-8');
    expect(indexes).toContain('idx_listings_created_by');
    expect(indexes).toContain('idx_sessions_expires_revoked');
    expect(safety).toContain('prevent_last_active_admin');
  });
});
