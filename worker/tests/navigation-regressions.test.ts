import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST_PUBLIC = resolve(__dirname, '../../dist-public');

type AssetManifest = {
  runtime: string;
  assets: Record<string, string>;
  pages: Array<{ relativePath: string }>;
};

function readDist(relativePath: string): string {
  return readFileSync(resolve(DIST_PUBLIC, relativePath.replace(/^\//, '')), 'utf8');
}

function manifest(): AssetManifest {
  return JSON.parse(readDist('asset-manifest.json')) as AssetManifest;
}

function generatedAsset(sourcePath: string): string {
  const generated = manifest().assets[sourcePath];
  expect(generated, `${sourcePath} must be emitted`).toBeTruthy();
  return readDist(generated);
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
    const runtime = readDist(manifest().runtime);
    const scheduleNavigation = runtime.match(/function scheduleNavigation\(url\) \{[\s\S]*?\n  \}/)?.[0] || '';

    expect(scheduleNavigation).toContain('window.location.assign(url.href)');
    expect(scheduleNavigation).not.toContain('showPageSkeleton()');
  });

  it('routes the repeated footer Sign in control to the clean login page on every public page', () => {
    const clientRuntime = generatedAsset('js/client-data.js');

    expect(clientRuntime).toContain("document.querySelectorAll('footer .footer-col a')");
    expect(clientRuntime).toContain("link.setAttribute('href', '/login')");

    const clientUrl = manifest().assets['js/client-data.js'];
    for (const page of manifest().pages) {
      const html = readDist(page.relativePath);
      expect(html, page.relativePath).toContain(clientUrl);
    }
  });

  it('opens rich user profiles and gives approved legacy listing agents a safe profile fallback', () => {
    const listingPage = readDist('listing-detail.html');
    const listingLinkUrl = manifest().assets['js/listing-agent-profile-link.js'];
    const listingLink = generatedAsset('js/listing-agent-profile-link.js');
    const profileClient = generatedAsset('js/agent-profile.js');

    expect(listingPage).toContain(listingLinkUrl);
    expect(listingLink).toContain("#detailContent .detail-sidebar .detail-contact-card");
    expect(listingLink).toContain('/agent-profile?id=${encodeURIComponent(candidateId)}');
    expect(listingLink).toContain('/agent-profile?listing=${encodeURIComponent(publicListingId)}');
    expect(listingLink).toContain("document.createTextNode(' View full agent profile')");
    expect(profileClient).toContain('function legacyProfileFromListing(listing)');
    expect(profileClient).toContain('return loadUserProfile(ownerId)');
    expect(profileClient).toContain('/api/listings/${encodeURIComponent(listingId)}');
    expect(profileClient).toContain('legacyListingProfile: true');
  });
});
