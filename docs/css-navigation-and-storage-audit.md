# CSS, navigation, and storage-integrity follow-up

Branch: `security-surgical-fixes-7aec332`  
Base commit: `7aec33235617319912c1bcad156f6b69c7dc3fe5`

## Why ordinary navigation showed an unstyled page

The production Worker was still serving the older deployed revision because the fixes existed only on a draft branch. The source also used relative, unversioned CSS and JavaScript URLs. A normal link navigation or browser back-forward cache restore could therefore reuse an older HTML document while requesting assets from a different Worker revision. A hard refresh discarded the reused document and forced a coherent set of responses, which made the styling appear again.

The final repair is structural:

1. `public/` is source only.
2. `npm run build:public` creates `dist-public/`.
3. Every local CSS and JavaScript file referenced by a page is content-hashed under `/assets/`.
4. Every internal page and asset URL is root-absolute.
5. Every page contains a build identifier that is also recorded in `asset-manifest.json`.
6. Hashed assets are immutable for one year.
7. Stable legacy aliases such as `/styles.css` and `/js/app.js` always revalidate, so an old browser tab still receives valid content.
8. HTML is `private, no-store` and receives a fresh CSP nonce.
9. `.html` and trailing-slash page variants redirect to one clean canonical URL.
10. The temporary `csp-events.js` and `csp-compat.css` files are deleted and return 404.

## Strict CSP conversion

The deployable bundle is rejected unless all generated pages and scripts satisfy these conditions:

- no `style="..."` attributes;
- no inline `<style>` blocks;
- no inline `<script>` blocks;
- no `onclick`, `onchange`, `onerror`, `onsubmit`, `oninput`, or similar attributes;
- no `.style` property assignments;
- no `.onclick` or equivalent event-property assignments;
- no `eval` or `new Function`;
- no relative local asset URLs.

Static page styles are extracted into generated hashed CSS files. JavaScript-generated visual state is converted into CSS classes inserted through a nonce-authorized stylesheet. Static event attributes become page-specific external listener files. Dynamic event-property replacement uses a listener registry that removes the previous listener before attaching the replacement.

The resulting CSP includes:

```text
script-src-attr 'none'
style-src-attr 'none'
```

It does not rely on `unsafe-inline` for scripts or style attributes.

## Pull and test

```bash
cd /path/to/primeprop-nigeria

git fetch origin
git switch security-surgical-fixes-7aec332
git pull --ff-only origin security-surgical-fixes-7aec332

cd worker
npm ci
npm run test:all
```

## Deploy

Back up D1 and apply the reviewed migrations before deployment.

```bash
cd worker

npx wrangler d1 export primeprop-db \
  --remote \
  --output="primeprop-db-before-css-navigation-fix-$(date +%Y%m%d-%H%M%S).sql"

npx wrangler d1 migrations apply primeprop-db --remote
npm run deploy
```

`npm run deploy` always rebuilds `dist-public/`; it does not deploy the raw `public/` directory.

## Verify every deployed page and asset

```bash
cd worker
PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" \
  npm run verify:deployment
```

The command verifies:

- the public asset manifest;
- every generated page;
- every hashed CSS and JavaScript asset referenced by those pages;
- matching page build identifiers;
- strict CSP directives;
- no-store HTML behavior;
- absence of inline CSS, scripts, and event attributes;
- stable legacy aliases;
- canonical page redirects;
- 404 responses for the retired compatibility files.

A successful result ends with:

```json
{
  "event": "primeprop_deployment_verification_passed"
}
```

## Equivalent focused curl checks

```bash
BASE_URL="https://primeprop-worker.ndupsn.workers.dev"

curl -fsS -D - -o /dev/null "$BASE_URL/styles.css"
curl -fsS -D - -o /dev/null "$BASE_URL/js/app.js"
curl -fsS -D /tmp/primeprop-areas.headers -o /tmp/primeprop-areas.html "$BASE_URL/areas"
curl -fsS "$BASE_URL/asset-manifest.json" -o /tmp/primeprop-asset-manifest.json

grep -i '^content-security-policy:' /tmp/primeprop-areas.headers
grep -i '^cache-control:' /tmp/primeprop-areas.headers
grep -F 'style-src-attr '\''none'\''' /tmp/primeprop-areas.headers
grep -F 'script-src-attr '\''none'\''' /tmp/primeprop-areas.headers

test "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/csp-compat.css")" = "404"
test "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/js/csp-events.js")" = "404"
```

The complete Node verifier should be preferred because it follows the manifest and checks all pages rather than one sample page.

## Read-only D1 and R2 integrity audit

The Worker now provides:

```text
GET /auth/security/storage-audit
```

The route requires a current active administrator access token. It is read-only and does not delete, modify, quarantine, or download object bodies.

It compares:

- every R2 object and its metadata;
- every `upload_objects` ownership row;
- listing media;
- listing agent avatars;
- district images;
- user avatars.

It reports:

- R2 objects without ownership rows;
- ownership rows whose R2 object is missing;
- referenced objects missing from R2;
- referenced R2 objects without ownership rows;
- tracked but unreferenced objects;
- suspicious object keys;
- unapproved or missing content types;
- oversized objects;
- D1/R2 size mismatches;
- invalid or insecure external media URLs.

After deployment, obtain a current administrator access token without storing the password in the repository or command history. Then run:

```bash
cd worker

export PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev"
export PRIMEPROP_ADMIN_BEARER="<current-admin-access-token>"
npm run audit:cloudflare-data
unset PRIMEPROP_ADMIN_BEARER
```

Reports are written with owner-only permissions under `worker/audit-output/` and are ignored by Git.

The audit exits with status `3` when high-severity findings exist. That is a review signal, not an automatic deletion action. Inspect the JSON and Markdown reports before deciding whether an object should be restored, relinked, quarantined, or deleted.

## Production limitation

Repository tests prove the audit logic against isolated D1 and R2 bindings. They do not inspect the live account until this branch is deployed and the authenticated command is run. Do not describe production D1 or R2 data as clean until the generated report has been reviewed.
