import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKER_DIR = resolve(__dirname, '..');
const rateLimiter = readFileSync(resolve(WORKER_DIR, 'src/rate-limiter.ts'), 'utf8');
const wrangler = readFileSync(resolve(WORKER_DIR, 'wrangler.toml'), 'utf8');

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Cloudflare usage controls', () => {
  it('uses one-shot rate-limit expiry rather than permanent recurring alarms', () => {
    const constructorSource = section(rateLimiter, 'constructor(', '// Check if a request');
    const checkSource = section(rateLimiter, 'async checkLimit(', '// Reset a specific key');
    const alarmSource = rateLimiter.slice(rateLimiter.indexOf('async alarm():'));

    expect(constructorSource).not.toContain('setAlarm(');
    expect(checkSource).toContain('setAlarm(entry.resetAt)');
    expect(alarmSource).not.toContain('setAlarm(');
    expect(alarmSource).toContain('this.storage.delete(');
    expect(rateLimiter).not.toContain('CLEANUP_INTERVAL_MS');
  });

  it('cancels the pending expiry alarm when a rate limit is reset', () => {
    const resetSource = section(rateLimiter, 'async resetLimit(', '// One-shot expiry cleanup');

    expect(resetSource).toContain('this.storage.delete(key)');
    expect(resetSource).toContain('this.storage.deleteAlarm()');
  });

  it('serves generated immutable assets without invoking the Worker script', () => {
    expect(wrangler).toContain('run_worker_first = ["/*", "!/assets/*"]');
    expect(wrangler).not.toMatch(/^run_worker_first\s*=\s*true\s*$/m);
  });

  it('does not configure a Cloudflare Queue producer or consumer', () => {
    expect(wrangler).not.toContain('[[queues.producers]]');
    expect(wrangler).not.toContain('[[queues.consumers]]');
  });
});
