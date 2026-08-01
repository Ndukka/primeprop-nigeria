import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const baseUrl = (process.env.PRIMEPROP_BASE_URL || '').replace(/\/+$/, '');

if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
  console.error('Set PRIMEPROP_BASE_URL to the deployed HTTPS application origin.');
  process.exit(2);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

const maxAttempts = boundedInteger(process.env.PRIMEPROP_VERIFY_ATTEMPTS, 12, 1, 30);
const retryDelayMs = boundedInteger(process.env.PRIMEPROP_VERIFY_DELAY_MS, 5000, 250, 30000);
const requiredStablePasses = boundedInteger(process.env.PRIMEPROP_VERIFY_STABLE_PASSES, 2, 1, 5);
const runToken = randomUUID();

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function expectedContentHash(pathname) {
  return pathname.match(/\.([a-f0-9]{12})\.(?:css|js)$/i)?.[1]?.toLowerCase() || '';
}

function requestUrl(pathname, attempt, requestNumber) {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set('__pp_verify', `${runToken}-${attempt}-${requestNumber}`);
  return url;
}

async function verifyRound(attempt) {
  const failures = [];
  const checkedAssets = new Set();
  let requestNumber = 0;

  function fail(subject, detail, response) {
    const ray = response?.headers?.get('cf-ray') || '';
    failures.push({
      subject,
      detail: ray ? `${detail}; cf-ray=${ray}` : detail,
    });
  }

  async function fetchChecked(pathname, options = {}) {
    requestNumber += 1;
    const url = requestUrl(pathname, attempt, requestNumber);
    try {
      return await fetch(url, {
        redirect: options.redirect || 'follow',
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      fail(pathname, error instanceof Error ? error.message : 'Network request failed');
      return null;
    }
  }

  async function verifyAsset(pathname, expectedPattern) {
    if (checkedAssets.has(pathname)) return;
    checkedAssets.add(pathname);

    const response = await fetchChecked(pathname);
    if (!response) return;
    if (response.status !== 200) {
      fail(pathname, `Expected HTTP 200, received ${response.status}`, response);
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (expectedPattern && !expectedPattern.test(contentType)) {
      fail(pathname, `Unexpected content type ${contentType || 'missing'}`, response);
    }

    const body = await response.text();
    if (body.length === 0) {
      fail(pathname, 'Asset body is empty', response);
      return;
    }

    const expectedHash = expectedContentHash(new URL(pathname, baseUrl).pathname);
    if (expectedHash) {
      const actualHash = digest(body).slice(0, 12);
      if (actualHash !== expectedHash) {
        fail(pathname, `Content hash mismatch: expected ${expectedHash}, received ${actualHash}`, response);
      }
    }
  }

  const manifestResponse = await fetchChecked('/asset-manifest.json');
  let manifest = null;
  let manifestIdentity = '';

  if (!manifestResponse || manifestResponse.status !== 200) {
    fail(
      '/asset-manifest.json',
      `Expected HTTP 200, received ${manifestResponse?.status ?? 'network failure'}`,
      manifestResponse,
    );
  } else {
    const manifestText = await manifestResponse.text();
    manifestIdentity = digest(manifestText).slice(0, 16);
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      fail('/asset-manifest.json', 'Response is not valid JSON', manifestResponse);
    }
  }

  if (manifest) {
    for (const [source, output] of Object.entries(manifest.assets || {})) {
      if (!/\.(?:css|js)$/i.test(source)) continue;
      await verifyAsset(
        String(output),
        source.endsWith('.css') ? /text\/css/i : /javascript|text\/plain/i,
      );
    }

    for (const page of manifest.pages || []) {
      const relativePath = String(page.relativePath || '');
      const pathname = relativePath === 'index.html'
        ? '/'
        : `/${relativePath.replace(/\.html$/i, '')}`;
      const response = await fetchChecked(pathname);
      if (!response) continue;
      if (response.status !== 200) {
        fail(pathname, `Expected HTTP 200, received ${response.status}`, response);
        continue;
      }

      const finalPath = new URL(response.url).pathname;
      if (finalPath !== pathname) {
        fail(pathname, `Resolved to non-canonical path ${finalPath}`, response);
      }

      const csp = response.headers.get('content-security-policy') || '';
      const cacheControl = response.headers.get('cache-control') || '';
      const html = await response.text();

      if (!csp.includes("script-src-attr 'none'")) fail(pathname, 'CSP does not block script attributes', response);
      if (!csp.includes("style-src-attr 'none'")) fail(pathname, 'CSP does not block style attributes', response);
      if (/(?:script-src|style-src-attr)[^;]*'unsafe-inline'/.test(csp)) {
        fail(pathname, 'CSP still contains unsafe-inline for scripts or style attributes', response);
      }
      if (!/\bno-store\b/i.test(cacheControl)) {
        fail(pathname, `HTML cache policy is ${cacheControl || 'missing'}`, response);
      }
      if (/\sstyle\s*=/i.test(html)) fail(pathname, 'Deployable HTML contains a style attribute', response);
      if (/\son[a-z]+\s*=/i.test(html)) fail(pathname, 'Deployable HTML contains an inline event attribute', response);
      if (/<style\b/i.test(html)) fail(pathname, 'Deployable HTML contains an inline style block', response);
      if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(pathname, 'Deployable HTML contains an inline script block', response);
      if (!html.includes(`name="primeprop-build" content="${page.buildId}"`)) {
        fail(pathname, 'HTML build identifier does not match the manifest', response);
      }

      const localAssets = [...html.matchAll(/\b(?:href|src)=["'](\/assets\/[^"']+)["']/g)]
        .map(match => match[1]);
      if (localAssets.length === 0) fail(pathname, 'Page references no hashed local assets', response);
      for (const asset of localAssets) {
        await verifyAsset(asset, /text\/css|javascript|text\/plain/i);
      }
    }
  }

  for (const pathname of ['/styles.css', '/js/app.js']) {
    await verifyAsset(pathname, pathname.endsWith('.css') ? /text\/css/i : /javascript|text\/plain/i);
  }

  for (const pathname of ['/csp-compat.css', '/js/csp-events.js']) {
    const response = await fetchChecked(pathname, { redirect: 'manual' });
    if (response && response.status !== 404) {
      fail(pathname, `Retired compatibility asset should return 404, received ${response.status}`, response);
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
      fail(variant, `Expected HTTP 307, received ${response.status}`, response);
      continue;
    }

    const location = response.headers.get('location') || '';
    const actualPath = location ? new URL(location, baseUrl).pathname : '';
    if (actualPath !== expected) {
      fail(variant, `Expected Location path ${expected}, received ${location || 'missing'}`, response);
    }
  }

  return {
    attempt,
    manifestIdentity,
    pages: manifest?.pages?.length || 0,
    assets: checkedAssets.size,
    failures,
  };
}

let consecutivePasses = 0;
let passingManifestIdentity = '';
const attempts = [];

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = await verifyRound(attempt);
  attempts.push({
    attempt,
    manifestIdentity: result.manifestIdentity,
    failureCount: result.failures.length,
    failures: result.failures.slice(0, 8),
  });

  if (result.failures.length === 0 && result.manifestIdentity) {
    if (result.manifestIdentity === passingManifestIdentity) {
      consecutivePasses += 1;
    } else {
      passingManifestIdentity = result.manifestIdentity;
      consecutivePasses = 1;
    }

    if (consecutivePasses >= requiredStablePasses) {
      console.log(JSON.stringify({
        event: 'primeprop_deployment_verification_passed',
        baseUrl,
        pages: result.pages,
        assets: result.assets,
        manifestIdentity: result.manifestIdentity,
        stablePasses: consecutivePasses,
        attemptsUsed: attempt,
        failures: [],
      }, null, 2));
      process.exit(0);
    }
  } else {
    consecutivePasses = 0;
    passingManifestIdentity = '';
  }

  if (attempt < maxAttempts) {
    console.error(JSON.stringify({
      event: 'primeprop_deployment_verification_retry',
      attempt,
      manifestIdentity: result.manifestIdentity,
      failureCount: result.failures.length,
      firstFailures: result.failures.slice(0, 5),
    }));
    await delay(retryDelayMs);
  }
}

const lastAttempt = attempts.at(-1) || { failures: [] };
console.log(JSON.stringify({
  event: 'primeprop_deployment_verification_failed',
  baseUrl,
  maxAttempts,
  requiredStablePasses,
  failures: lastAttempt.failures,
  attempts,
}, null, 2));
process.exitCode = 1;
