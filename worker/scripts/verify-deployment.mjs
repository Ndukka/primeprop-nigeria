import { createHash } from 'node:crypto';

const baseUrl = (process.env.PRIMEPROP_BASE_URL || '').replace(/\/+$/, '');

if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
  console.error('Set PRIMEPROP_BASE_URL to the deployed HTTPS application origin.');
  process.exit(2);
}

const failures = [];
const checkedAssets = new Set();

function fail(subject, detail) {
  failures.push({ subject, detail });
}

async function fetchChecked(path, options = {}) {
  try {
    return await fetch(`${baseUrl}${path}`, {
      redirect: options.redirect || 'follow',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    fail(path, error instanceof Error ? error.message : 'Network request failed');
    return null;
  }
}

function expectedContentHash(path) {
  return path.match(/\.([a-f0-9]{12})\.(?:css|js)$/i)?.[1]?.toLowerCase() || '';
}

async function verifyAsset(path, expectedPattern) {
  if (checkedAssets.has(path)) return;
  checkedAssets.add(path);
  const response = await fetchChecked(path);
  if (!response) return;
  if (response.status !== 200) {
    fail(path, `Expected HTTP 200, received ${response.status}`);
    return;
  }
  const contentType = response.headers.get('content-type') || '';
  if (expectedPattern && !expectedPattern.test(contentType)) {
    fail(path, `Unexpected content type ${contentType || 'missing'}`);
  }

  const body = await response.text();
  if (body.length === 0) {
    fail(path, 'Asset body is empty');
    return;
  }

  // Generated asset names contain the first 12 hexadecimal characters of the
  // SHA-256 body digest. Validate that contract instead of assuming legitimate
  // JavaScript or CSS must exceed an arbitrary byte count. Small page-specific
  // listener files are valid and should not fail solely because they are short.
  const expectedHash = expectedContentHash(path);
  if (expectedHash) {
    const actualHash = createHash('sha256').update(body).digest('hex').slice(0, 12);
    if (actualHash !== expectedHash) {
      fail(path, `Content hash mismatch: expected ${expectedHash}, received ${actualHash}`);
    }
  }
}

const manifestResponse = await fetchChecked('/asset-manifest.json');
let manifest = null;
if (!manifestResponse || manifestResponse.status !== 200) {
  fail('/asset-manifest.json', `Expected HTTP 200, received ${manifestResponse?.status ?? 'network failure'}`);
} else {
  try {
    manifest = await manifestResponse.json();
  } catch {
    fail('/asset-manifest.json', 'Response is not valid JSON');
  }
}

if (manifest) {
  for (const [source, url] of Object.entries(manifest.assets || {})) {
    if (!/\.(?:css|js)$/i.test(source)) continue;
    await verifyAsset(
      String(url),
      source.endsWith('.css') ? /text\/css/i : /javascript|text\/plain/i,
    );
  }

  for (const page of manifest.pages || []) {
    const relativePath = String(page.relativePath || '');
    const path = relativePath === 'index.html'
      ? '/'
      : `/${relativePath.replace(/\.html$/i, '')}`;
    const response = await fetchChecked(path);
    if (!response) continue;
    if (response.status !== 200) {
      fail(path, `Expected HTTP 200, received ${response.status}`);
      continue;
    }

    const finalPath = new URL(response.url).pathname;
    if (finalPath !== path) fail(path, `Resolved to non-canonical path ${finalPath}`);

    const csp = response.headers.get('content-security-policy') || '';
    const cacheControl = response.headers.get('cache-control') || '';
    const html = await response.text();

    if (!csp.includes("script-src-attr 'none'")) fail(path, 'CSP does not block script attributes');
    if (!csp.includes("style-src-attr 'none'")) fail(path, 'CSP does not block style attributes');
    if (/(?:script-src|style-src-attr)[^;]*'unsafe-inline'/.test(csp)) {
      fail(path, 'CSP still contains unsafe-inline for scripts or style attributes');
    }
    if (!/\bno-store\b/i.test(cacheControl)) fail(path, `HTML cache policy is ${cacheControl || 'missing'}`);
    if (/\sstyle\s*=/i.test(html)) fail(path, 'Deployable HTML contains a style attribute');
    if (/\son[a-z]+\s*=/i.test(html)) fail(path, 'Deployable HTML contains an inline event attribute');
    if (/<style\b/i.test(html)) fail(path, 'Deployable HTML contains an inline style block');
    if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(path, 'Deployable HTML contains an inline script block');
    if (!html.includes(`name="primeprop-build" content="${page.buildId}"`)) {
      fail(path, 'HTML build identifier does not match the manifest');
    }

    const localAssets = [...html.matchAll(/\b(?:href|src)=["'](\/assets\/[^"']+)["']/g)]
      .map(match => match[1]);
    if (localAssets.length === 0) fail(path, 'Page references no hashed local assets');
    for (const asset of localAssets) {
      await verifyAsset(asset, /text\/css|javascript|text\/plain/i);
    }
  }
}

for (const path of ['/styles.css', '/js/app.js']) {
  await verifyAsset(path, path.endsWith('.css') ? /text\/css/i : /javascript|text\/plain/i);
}

for (const path of ['/csp-compat.css', '/js/csp-events.js']) {
  const response = await fetchChecked(path, { redirect: 'manual' });
  if (response && response.status !== 404) {
    fail(path, `Retired compatibility asset should return 404, received ${response.status}`);
  }
}

for (const [variant, expected] of [
  ['/areas.html', '/areas'],
  ['/areas/', '/areas'],
  ['/properties.html', '/properties'],
]) {
  const response = await fetchChecked(variant, { redirect: 'manual' });
  if (!response) continue;
  if (response.status !== 307) {
    fail(variant, `Expected HTTP 307, received ${response.status}`);
  } else if (response.headers.get('location') !== expected) {
    fail(variant, `Expected Location ${expected}, received ${response.headers.get('location') || 'missing'}`);
  }
}

const summary = {
  event: failures.length === 0
    ? 'primeprop_deployment_verification_passed'
    : 'primeprop_deployment_verification_failed',
  baseUrl,
  pages: manifest?.pages?.length || 0,
  assets: checkedAssets.size,
  failures,
};

console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) process.exitCode = 1;