# Security follow-up for commit 7aec332

Audited base: `7aec33235617319912c1bcad156f6b69c7dc3fe5`  
Fix branch: `security-surgical-fixes-7aec332`  
Pull request: `#1`

## Assessment of the base commit

Commit `7aec332` made meaningful progress. It removed the legacy Express backend, moved deployable assets into `public/`, removed the committed JWT value from Wrangler configuration, introduced explicit public DTOs, added D1 session and upload records, improved file validation, moved public signups to pending status, added database indexes and logging, and removed unsafe `innerHTML` assignments from the administrator and agent dashboards.

The commit was not release-ready, however. Several controls were incomplete, contradicted the existing frontend, or had not been executed by a real test runner.

## Confirmed defects found after 7aec332

1. The CSP nonce did not authorize `style="..."` attributes or JavaScript `element.style` assignments. Existing pages therefore broke under their own CSP.
2. Font Awesome fonts were blocked because `font-src` omitted `cdnjs.cloudflare.com`.
3. The repository did not prove that `/styles.css` and `/js/app.js` were served by the Worker-first asset path.
4. Existing nonce attributes were duplicated during HTML rewriting.
5. Inline event attributes remained throughout public pages while the CSP correctly set `script-src-attr 'none'`, leaving forms, pagination, favorites, lightboxes, uploads, and other interactions inactive.
6. `API_GUIDE.md` republished an administrator email and password.
7. Password-reset tokens were hashed in D1 but still printed in plaintext to Worker logs and were not delivered through a side channel.
8. Access JWTs were not checked against the user security stamp, so a stolen access token remained valid after password, email, role, or account-status changes.
9. The silent refresh code queried no role column and then signed replacement tokens with `dbUser.role`.
10. Refresh rotation and reuse detection were not exercised by a Worker-runtime test.
11. The final-administrator rule covered deletion but not demotion or banning.
12. New Google accounts were active immediately and bypassed pending-agent approval.
13. Google redirect validation used substring checks rather than exact origin and callback-path validation.
14. Google verification errors returned internal exception details.
15. The retired `0002_fix_admin.sql` migration contained comments only. Fresh D1 databases and migration tests failed because the migration had no SQL statement.
16. The Vitest configuration did not activate Cloudflare's Worker test pool. A single mixed test file also combined Worker-runtime APIs with Node child-process APIs.
17. No GitHub Actions status check existed for the target commit.
18. Nonce-modified HTML retained stale ETag, Last-Modified, Content-Length, and cache behavior.
19. Exact route interception could be bypassed with trailing slash variants.
20. GitHub Actions dependencies were referenced by mutable tags rather than reviewed commit SHAs.

## Surgical fixes applied

### CSP and asset delivery

- Kept scripts nonce-only and retained `script-src-attr 'none'`.
- Added `style-src-attr 'unsafe-inline'` temporarily because the current HTML and JavaScript still use inline CSS attributes and style-property assignments.
- Added the Font Awesome CDN to `font-src`.
- Replaced stale nonce attributes instead of duplicating them.
- Added `/csp-compat.css` and `/js/csp-events.js` to every HTML response.
- The event bridge uses an explicit function allowlist and argument parser. It does not use `eval` or `Function`.
- Added live tests for `/styles.css`, `/js/app.js`, compatibility assets, clean routes, nonce matching, no-store HTML, and removed validators.

### Authentication and session handling

- Added an immediate invalidation epoch for access JWTs.
- Rotated the security stamp after password, email, role, or account-status changes.
- Implemented D1-backed refresh rotation with the user's current role.
- Added refresh-family reuse detection and family-wide revocation.
- Prevented bearer-only API clients from silently using refresh-cookie behavior.
- Added exact Origin enforcement for cookie-authenticated writes.
- Normalized `/auth/*` and `/api/*` trailing slashes before routing.

### Account safety

- Added database triggers preventing deletion, demotion, or banning of the final active administrator.
- Made newly inserted Google identities pending.
- Cleared OAuth-created session cookies when approval is still required.
- Added exact OAuth redirect-origin and callback-path validation.
- Removed OAuth verifier exception details from external responses.

### Password recovery

- Replaced plaintext reset-token logging with a Resend delivery path.
- Reset tokens remain hashed in D1 and expire after 15 minutes.
- The route fails closed with 503 when the email provider, verified sender, or public URL is not configured.
- Added `reset-password.html` with `no-referrer` and immediate removal of the token from browser history.

### Database and testing

- Kept migration `0002` as a harmless `SELECT 1;` so fresh databases can apply the complete historical sequence without recreating the insecure credential.
- Added forward-only migrations `0012_account_safety.sql` and `0013_session_invalidation.sql`.
- Split source, Worker-runtime, and local Wrangler integration tests into compatible environments.
- Added isolated D1 migration setup and a test-only `.invalid` administrator.
- Added a mandatory GitHub Actions workflow.
- Pinned GitHub Actions by commit SHA.

## Test gate

Run from the repository root:

```bash
cd worker
npm ci
npm run typecheck
npm run test:static
npm run test:worker
npm run test:integration
```

Or run the complete gate:

```bash
cd worker
npm ci
npm run test:all
```

The integration suite creates an isolated Wrangler state directory, applies every migration, starts the exact locked Wrangler version, and checks real HTTP responses.

## Pull and test locally

```bash
git fetch origin
git switch security-surgical-fixes-7aec332
git pull --ff-only origin security-surgical-fixes-7aec332

cd worker
npm ci
npm run test:all
```

## Required owner steps before production deployment

### 1. Back up D1

```bash
cd worker
npx wrangler d1 export primeprop-db \
  --remote \
  --output="primeprop-db-before-security-follow-up-$(date +%Y%m%d-%H%M%S).sql"
```

Store the backup outside the repository.

### 2. Inspect existing administrator records

Editing historical migrations does not remove accounts already created in production. Review current administrators before applying account-safety triggers:

```bash
npx wrangler d1 execute primeprop-db --remote --command \
  "SELECT id, email, role, account_status, created_at FROM users WHERE role = 'admin' ORDER BY id;"
```

Do not delete or demote the final active administrator. Rotate any credential that was ever documented or committed.

### 3. Apply forward-only migrations

```bash
npx wrangler d1 migrations apply primeprop-db --remote
```

### 4. Configure secrets and deployment variables

Generate a new JWT secret. Do not reuse a value that ever appeared in Git, logs, documentation, or deployment output.

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REDIRECT_URI
```

Configure `PASSWORD_RESET_FROM` as a non-secret Worker variable using a sender verified by the email provider, for example:

```text
PrimeProp Nigeria <security@primeprop.ng>
```

`GOOGLE_REDIRECT_URI` must exactly equal one allowed application origin plus `/auth/google/callback`, with no query string or fragment.

### 5. Deploy

```bash
npm run deploy
```

### 6. Verify the deployed asset and CSP behavior

Replace the host below if the custom domain is active:

```bash
BASE_URL="https://primeprop-worker.ndupsn.workers.dev"

curl -fsS -D - -o /dev/null "$BASE_URL/styles.css"
curl -fsS -D - -o /dev/null "$BASE_URL/js/app.js"
curl -fsS -D - -o /dev/null "$BASE_URL/js/csp-events.js"
curl -fsS -D - -o /dev/null "$BASE_URL/csp-compat.css"
curl -fsS -D /tmp/primeprop-areas.headers -o /tmp/primeprop-areas.html "$BASE_URL/areas.html"

grep -i '^content-security-policy:' /tmp/primeprop-areas.headers
grep -i '^cache-control:' /tmp/primeprop-areas.headers
grep -F '/styles.css' /tmp/primeprop-areas.html
grep -F '/js/csp-events.js' /tmp/primeprop-areas.html
```

Expected results:

- Every asset request returns HTTP 200.
- `styles.css` returns a CSS content type.
- `app.js` and `csp-events.js` return a JavaScript content type.
- HTML includes a per-request nonce.
- The CSP contains `script-src-attr 'none'`.
- The CSP does not contain `unsafe-inline` in the `script-src` directive.
- HTML is served with `Cache-Control: private, no-store`.

### 7. Browser verification

Use a clean browser profile and verify:

- Area Guides loads with no CSP style or font errors.
- Login and signup forms submit.
- Listing pagination works.
- Favorite buttons work.
- Listing galleries and lightbox controls work.
- Administrator and agent upload controls work.
- Password reset returns 503 until Resend and the verified sender are configured.
- A newly created password or Google agent remains pending.
- An administrator can approve an agent.
- A demotion, ban, password change, or email change invalidates older sessions.

## Remaining work that is not honestly closed by repository code

1. Replace every inline style attribute and JavaScript style assignment with external CSS classes. Then remove `style-src-attr 'unsafe-inline'`.
2. Replace every inline event attribute with direct `addEventListener` registration. Then delete `csp-events.js` and its compatibility stylesheet.
3. Consolidate authentication into one implementation. The active production wrappers currently harden older route code, but dead or superseded paths should be removed to prevent future regression.
4. Test real Resend delivery, sender-domain authentication, bounce handling, and abuse controls.
5. Test Google OAuth against the real client configuration.
6. Rotate all previously exposed secrets and administrator credentials. Git history remains sensitive even after source cleanup.
7. Verify Cloudflare Access, administrator MFA, WAF, Turnstile, DNS, TLS mode, R2 policy, backups, logging destinations, alerts, and incident procedures in the Cloudflare account.
8. Review existing R2 objects and D1 content for malicious or orphaned data created before the new controls.
9. Add browser automation for all public and privileged journeys. HTTP integration tests do not prove layout, accessibility, or every interactive path.
10. Squash the fix branch when merging so the per-file GitHub API commits become one reviewed change set.

## Merge position

Keep pull request #1 in draft until:

- the latest Security CI run passes,
- the owner completes the D1 backup and migration rehearsal,
- production secrets and sender configuration are ready,
- browser smoke tests pass on a preview or staging deployment.
