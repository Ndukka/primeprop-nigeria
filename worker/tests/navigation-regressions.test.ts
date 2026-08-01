import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST_PUBLIC = resolve(__dirname, '../../dist-public');

function readDist(relativePath: string): string {
  return readFileSync(resolve(DIST_PUBLIC, relativePath.replace(/^\//, '')), 'utf8');
}

function scriptSources(html: string): string[] {
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map(match => match[1]);
}

describe('clean-route and loading regressions', () => {
  it('keeps administrator and agent redirects on the current origin', () => {
    const loginHtml = readDist('login.html');
    const loginScripts = scriptSources(loginHtml)
      .filter(source => source.includes('/assets/generated/login-inline-'))
      .map(readDist)
      .join('\n');

    expect(loginScripts).toMatch(/["']\/admin["']/);
    expect(loginScripts).toMatch(/["']\/agent["']/);
    expect(loginScripts).not.toMatch(/["']\/\/(?:admin|agent)(?:["'/?#])/);
  });

  it('does not automatically add a second full-page navigation skeleton', () => {
    const manifest = JSON.parse(readDist('asset-manifest.json')) as {
      runtime: string;
    };
    const runtime = readDist(manifest.runtime);
    const scheduleNavigation = runtime.match(/function scheduleNavigation\(url\) \{[\s\S]*?\n  \}/)?.[0] || '';

    expect(scheduleNavigation).toContain('window.location.assign(url.href)');
    expect(scheduleNavigation).not.toContain('showPageSkeleton()');
  });
});
