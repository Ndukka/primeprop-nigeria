# PrimeProp Nigeria Error Bank

This file is the permanent operational and engineering error bank for PrimeProp Nigeria. It must be updated whenever a defect, failed deployment, unsafe configuration, misleading test, or repeatable operator mistake is discovered.

The purpose is not merely to record that an error occurred. Every entry must preserve enough evidence and remediation detail for a future engineer to identify and repair the same class of failure without rediscovering the root cause.

## Maintenance rules

1. Never delete a resolved incident. Mark it resolved and add superseding information.
2. Add a new entry when the root cause differs, even when the visible symptom looks similar.
3. Update an existing entry when the root cause and repair are the same.
4. Record exact affected files, verification commands, and prevention tests.
5. Do not mark an incident resolved merely because the visible symptom disappeared after a hard refresh, cache purge, restart, or retry.
6. Temporary compatibility workarounds must have an explicit removal entry and test.
7. Production data must not be described as clean until the account-bound audit has actually run and its report has been reviewed.
8. Placeholder paths, tokens, emails, passwords, IDs, and secrets must never be copied into executable commands unchanged.
9. Every deployment-related repair must pass `npm run test:all` and the post-deployment verifier.
10. Never weaken CSP, authentication, authorization, validation, or tests merely to make a gate pass.

## Standard incident fields

Every future entry should include:

- **Status**: Open, mitigated, resolved, or owner action required.
- **First observed**: Date, commit, deployment version, or log reference.
- **Symptoms**: What the user or operator saw.
- **Root cause**: The technical reason the failure occurred.
- **Repair**: The exact code, configuration, migration, or process correction.
- **Prevention**: Tests or controls that stop recurrence.
- **Immediate diagnosis**: Fast commands or checks for future incidents.

---

## PP-ERR-001: Normal navigation produced an unstyled page

- **Status**: Resolved in branch; requires deployment of the latest branch head.
- **Symptoms**:
  - A page initially appeared without layout or CSS.
  - A hard refresh made the same page appear correctly.
  - Clicking another internal page caused the unstyled state to return.
- **Root cause**:
  - HTML referred to relative, unversioned stylesheet and script paths.
  - Normal navigation and browser back-forward cache could reuse an HTML document from one deployment while requesting assets from another deployment.
  - HTML and local assets did not have a single build identity.
  - Hard refresh appeared to repair the problem because it discarded the reused document and fetched a coherent response set.
- **Repair**:
  - `public/` is now source only.
  - `worker/scripts/build-public.mjs` creates `dist-public/`.
  - Every local CSS and JavaScript asset is content-hashed under `/assets/`.
  - Every internal reference is root-absolute.
  - Every page and `asset-manifest.json` contain the same build identifier.
  - Hashed assets are immutable.
  - Stable aliases such as `/styles.css` and `/js/app.js` revalidate for stale tabs.
  - HTML is served as `private, no-store` with a fresh nonce.
  - `.html` and trailing-slash page variants redirect to one canonical URL.
- **Prevention**:
  - Strict public build of all pages.
  - Manifest verification.
  - Live Wrangler tests for all 14 routes and all referenced assets.
  - Post-deployment `npm run verify:deployment`.
- **Immediate diagnosis**:
  ```bash
  PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" npm run verify:deployment
  curl -I https://primeprop-worker.ndupsn.workers.dev/styles.css
  curl -I https://primeprop-worker.ndupsn.workers.dev/areas
  ```

## PP-ERR-002: `/styles.css` or another required static asset returned 404

- **Status**: Resolved.
- **Symptoms**:
  - Browser console showed a failed stylesheet or script request.
  - The page rendered as plain HTML.
- **Root cause**:
  - Static asset publication was not proven by an executable HTTP test.
  - Asset directory and route behavior could drift independently.
- **Repair**:
  - Wrangler deploys only generated `dist-public/`.
  - Stable aliases are generated automatically.
  - The integration suite requests real CSS and JavaScript over HTTP.
- **Prevention**:
  - Manifest-driven deployment verifier checks every referenced hashed asset.
  - Stable aliases are checked separately.
- **Immediate diagnosis**:
  ```bash
  curl -fsS -D - -o /dev/null "$PRIMEPROP_BASE_URL/styles.css"
  curl -fsS -D - -o /dev/null "$PRIMEPROP_BASE_URL/js/app.js"
  curl -fsS "$PRIMEPROP_BASE_URL/asset-manifest.json"
  ```

## PP-ERR-003: CSP blocked `style="..."` attributes

- **Status**: Resolved.
- **Symptoms**:
  - Browser console reported that applying inline style violated CSP.
  - Elements lost layout, visibility, positioning, or fallback styling.
- **Root cause**:
  - The page used inline style attributes while CSP correctly attempted to block style attributes.
- **Repair**:
  - Static style attributes are compiled into generated CSS classes.
  - JavaScript-generated visual state is converted to nonce-authorized stylesheet rules.
  - Final CSP uses `style-src-attr 'none'`.
- **Prevention**:
  - Generated HTML is rejected when a style attribute remains.
  - Generated JavaScript is rejected when it creates inline style markup.
  - Every page is checked by source and live integration tests.

## PP-ERR-004: JavaScript `.style` assignments were blocked or violated the strict source policy

- **Status**: Resolved.
- **Symptoms**:
  - JavaScript attempted to hide, show, position, or recolor an element but the change failed.
  - Strict bundle tests rejected generated scripts.
- **Root cause**:
  - Runtime code directly assigned `element.style.property`.
- **Repair**:
  - Build preparation rewrites supported style assignments through `PrimePropStyles.set`.
  - The strict runtime creates nonce-authorized CSS rules and applies classes.
- **Prevention**:
  - Every generated JavaScript file is scanned for `.style`, bracket-style access, and direct style assignment.

## PP-ERR-005: Font Awesome icons rendered incorrectly because font files were blocked

- **Status**: Resolved.
- **Symptoms**:
  - Empty squares or missing icons despite Font Awesome CSS loading.
  - CSP console errors for cdnjs font resources.
- **Root cause**:
  - `font-src` permitted Google fonts but omitted the Font Awesome CDN.
- **Repair**:
  - Added `https://cdnjs.cloudflare.com` to `font-src`.
- **Prevention**:
  - Security-header tests assert the approved font origins.

## PP-ERR-006: Existing nonce attributes were duplicated

- **Status**: Resolved.
- **Symptoms**:
  - A script or style element contained more than one nonce attribute.
  - CSP behavior became browser-dependent or difficult to diagnose.
- **Root cause**:
  - Nonce injection appended a nonce without first removing an existing value.
- **Repair**:
  - Existing nonce attributes are removed and replaced exactly once.
- **Prevention**:
  - Security-header tests verify replacement behavior.

## PP-ERR-007: Inline event attributes were blocked by `script-src-attr 'none'`

- **Status**: Resolved.
- **Symptoms**:
  - Buttons, filters, forms, pagination, favorites, upload zones, lightboxes, or dashboard controls appeared clickable but did nothing.
- **Root cause**:
  - HTML and JavaScript-generated markup still used `onclick`, `onchange`, `oninput`, `onerror`, or similar attributes while CSP blocked script attributes.
- **Repair**:
  - Static event attributes are extracted into generated external listener files.
  - Dynamic actions use declarative `data-pp-*` attributes.
  - The strict runtime attaches direct listeners.
- **Prevention**:
  - Build fails when any inline event attribute remains in HTML or JavaScript-generated markup.
  - CSP retains `script-src-attr 'none'`.

## PP-ERR-008: Runtime `.onclick = handler` replacement stacked or retained obsolete behavior

- **Status**: Resolved.
- **Symptoms**:
  - A dashboard action executed multiple handlers after switching tabs.
  - An old modal action remained active after the visible button label changed.
- **Root cause**:
  - Replacing event properties with ordinary `addEventListener` calls would accumulate listeners rather than replace the former one.
- **Repair**:
  - `PrimePropEvents.replace` tracks the previous listener for each target and event.
  - It removes the previous listener before attaching the replacement.
- **Prevention**:
  - Build rejects event-property assignments.
  - Runtime source tests require the replacement registry.

## PP-ERR-009: Temporary CSP compatibility bridge became production coupling

- **Status**: Resolved and removed.
- **Symptoms**:
  - Production depended on `/js/csp-events.js` and `/csp-compat.css`.
  - Compatibility parsing risked preserving inline-handler concepts indefinitely.
- **Root cause**:
  - A temporary bridge was introduced before all inline handlers and style attributes were migrated.
- **Repair**:
  - All handlers and styles are compiled or attached directly.
  - Both compatibility files were deleted.
  - Their deployed URLs must return 404.
- **Prevention**:
  - Source, integration, and deployment verification assert that the files are absent.

## PP-ERR-010: Nonce-mutated HTML retained stale validators and content length

- **Status**: Resolved.
- **Symptoms**:
  - Cached or conditionally requested HTML could mismatch the body after nonce injection.
  - Content length, ETag, or Last-Modified described the original asset rather than the rewritten response.
- **Root cause**:
  - Response metadata from the static asset was retained after the Worker changed the HTML body.
- **Repair**:
  - Rewritten HTML removes `Content-Length`, `ETag`, and `Last-Modified`.
  - HTML receives `private, no-store, max-age=0` and `Pragma: no-cache`.
- **Prevention**:
  - Live tests check the HTML cache policy.

## PP-ERR-011: Route protection could be bypassed with a trailing slash

- **Status**: Resolved.
- **Symptoms**:
  - `/auth/path` and `/auth/path/` behaved differently.
  - Exact route interception did not apply to all equivalent forms.
- **Root cause**:
  - Path normalization occurred after security-sensitive routing decisions or not at all.
- **Repair**:
  - Production entry normalizes trailing slashes before API and authentication routing.
  - Public `.html` and trailing-slash variants redirect to canonical clean URLs.
- **Prevention**:
  - Integration tests exercise both canonical and noncanonical forms.

## PP-ERR-012: OAuth redirect validation used substring matching

- **Status**: Resolved.
- **Symptoms**:
  - A malicious hostname containing an approved word could pass validation.
- **Root cause**:
  - Redirect validation checked whether the URI contained `workers.dev` or `primeprop` instead of validating a complete origin and callback path.
- **Repair**:
  - Redirect URI validation is exact for approved origin, protocol, and callback path.
- **Prevention**:
  - OAuth routing is wrapped by `production-entry.ts` and tested against invalid variants.

## PP-ERR-013: OAuth verifier errors leaked implementation detail

- **Status**: Resolved.
- **Symptoms**:
  - User-visible responses exposed provider or verification exception text.
- **Root cause**:
  - Raw verifier failures were returned to the client.
- **Repair**:
  - Detailed failures are scrubbed from public responses.
  - Only a controlled generic message is returned.
- **Prevention**:
  - Production entry normalizes callback errors.

## PP-ERR-014: New Google users bypassed pending approval

- **Status**: Resolved.
- **Symptoms**:
  - A newly created OAuth account could enter the application immediately while password signups remained pending.
- **Root cause**:
  - OAuth account creation used a different account-status path.
- **Repair**:
  - New Google-created accounts are forced to pending.
  - Authentication cookies are cleared and the user is redirected to pending status.
  - Database safeguards reinforce the rule.
- **Prevention**:
  - Migration and runtime tests cover pending OAuth identities.

## PP-ERR-015: Password-reset token was logged in plaintext

- **Status**: Resolved.
- **Symptoms**:
  - A valid reset credential could appear in Worker logs.
- **Root cause**:
  - Development-oriented token logging remained in the production path.
- **Repair**:
  - Tokens are never logged or returned.
  - Only SHA-256 hashes are stored.
  - Failure logs contain user ID and event type, not the token.
- **Prevention**:
  - Static source review and recovery-flow tests.

## PP-ERR-016: Password-reset token was generated but not delivered

- **Status**: Resolved in code; provider configuration remains owner-controlled.
- **Symptoms**:
  - Password recovery appeared successful but no usable email was sent.
- **Root cause**:
  - The implementation created reset records without a production email provider path.
- **Repair**:
  - Resend delivery was added.
  - Links are single-use and expire after 15 minutes.
  - The endpoint fails closed with 503 when Resend, sender, or public URL configuration is missing.
- **Prevention**:
  - Recovery code deletes the reset record when delivery fails.
  - Production must configure `RESEND_API_KEY` and `PASSWORD_RESET_FROM`.

## PP-ERR-017: Existing access tokens survived password, email, role, or status changes

- **Status**: Resolved.
- **Symptoms**:
  - A previously issued access token remained usable after a security-sensitive account change.
- **Root cause**:
  - JWT validity depended only on signature and expiry.
- **Repair**:
  - Added D1-backed security-stamp invalidation epochs.
  - Password, email, role, and account-status changes rotate the security stamp.
  - Requests compare token issuance time with the current invalidation epoch.
- **Prevention**:
  - Migration `0013_session_invalidation.sql` and runtime tests.

## PP-ERR-018: Silent refresh used a role that was not selected from D1

- **Status**: Resolved.
- **Symptoms**:
  - A refreshed access token could contain an undefined or stale role.
- **Root cause**:
  - The refresh query did not select `role` but later read `dbUser.role`.
- **Repair**:
  - Hardened refresh loads current user identity and role from D1.
- **Prevention**:
  - Worker-runtime authentication tests exercise refresh behavior.

## PP-ERR-019: Refresh-token rotation was not meaningfully tested

- **Status**: Resolved.
- **Symptoms**:
  - Source appeared to implement rotation, but no Worker-bound test proved session-family behavior.
- **Root cause**:
  - Earlier tests ran in an incompatible environment and did not exercise actual bindings.
- **Repair**:
  - Added isolated Worker tests for access/refresh token separation, session creation, rotation, and reuse handling.
- **Prevention**:
  - Worker suite must remain separate from Node-only tests.

## PP-ERR-020: The final active administrator could be demoted, banned, or deleted

- **Status**: Resolved.
- **Symptoms**:
  - Administrative actions could leave the system with no active administrator.
- **Root cause**:
  - Application checks were incomplete and could be bypassed by another write path.
- **Repair**:
  - Added database-layer triggers in `0012_account_safety.sql`.
  - Application checks remain as a user-facing first layer.
- **Prevention**:
  - Migration tests and source assertions require `prevent_last_active_admin`.

## PP-ERR-021: Fresh D1 migration failed because `0002_fix_admin.sql` contained comments only

- **Status**: Resolved.
- **Symptoms**:
  - A new local database could not apply the complete migration catalogue.
- **Root cause**:
  - A retired migration was emptied rather than retained as valid immutable history.
- **Repair**:
  - `0002_fix_admin.sql` is a safe `SELECT 1;` no-op.
- **Prevention**:
  - Every integration run applies all migrations to an empty local database.

## PP-ERR-022: Node and Cloudflare Worker tests were mixed in one Vitest environment

- **Status**: Resolved.
- **Symptoms**:
  - Tests passed without real Worker bindings or failed unpredictably due to environment mismatch.
- **Root cause**:
  - One Vitest configuration attempted to run Node source checks and Worker-runtime code together.
- **Repair**:
  - Split into Node source tests, Worker-pool tests, and live Wrangler HTTP tests.
- **Prevention**:
  - `npm run test:all` runs each environment explicitly.

## PP-ERR-023: No meaningful mandatory CI gate existed

- **Status**: Resolved.
- **Symptoms**:
  - A branch could appear complete without typecheck, Worker tests, migration tests, or live asset delivery tests.
- **Root cause**:
  - Repository validation was local and informal.
- **Repair**:
  - Added Security CI covering dependency installation, TypeScript, static build, Worker runtime, and live Wrangler integration.
- **Prevention**:
  - Do not merge when the Security CI status is absent or failing.

## PP-ERR-024: GitHub Actions used mutable tags

- **Status**: Resolved.
- **Symptoms**:
  - CI behavior could change without a repository commit.
- **Root cause**:
  - Workflow actions referenced floating version tags.
- **Repair**:
  - Actions are pinned to exact commit SHAs.
- **Prevention**:
  - Review action-SHA updates as dependency changes.

## PP-ERR-025: Administrator credentials were published in documentation

- **Status**: Resolved; credential rotation remains mandatory if the values were ever used.
- **Symptoms**:
  - API documentation contained an administrator email/password combination.
- **Root cause**:
  - Setup examples used live-looking credentials instead of secure provisioning instructions.
- **Repair**:
  - Removed credentials from `API_GUIDE.md`.
  - Documentation now describes secret provisioning without values.
- **Prevention**:
  - Static tests reject the retired credential pattern.
  - Rotate any credential that was previously committed or documented.

## PP-ERR-026: JWT signing secret was committed in Wrangler configuration

- **Status**: Resolved; secret rotation is owner-controlled.
- **Symptoms**:
  - Source-controlled configuration contained a JWT signing value.
- **Root cause**:
  - Secret and non-secret configuration were not separated.
- **Repair**:
  - Removed the value from `wrangler.toml`.
  - Secrets must be configured with Wrangler or Cloudflare Secrets Store.
- **Prevention**:
  - Static tests reject `JWT_SECRET = "value"` in Wrangler.

## PP-ERR-027: Legacy Express backend remained alongside the Worker

- **Status**: Resolved in the audited base commit.
- **Symptoms**:
  - Duplicate backend implementations created uncertain routing, security, and maintenance ownership.
- **Root cause**:
  - Migration to Workers did not remove the retired server.
- **Repair**:
  - Removed the legacy Express backend.
- **Prevention**:
  - One production entry point is defined in Wrangler.

## PP-ERR-028: Deployment could expose files outside the intended public application

- **Status**: Resolved.
- **Symptoms**:
  - Build context risked publishing repository files not intended for browsers.
- **Root cause**:
  - Static asset scope was insufficiently constrained.
- **Repair**:
  - Only generated `dist-public/` is deployable.
- **Prevention**:
  - Wrangler test asserts the asset directory.

## PP-ERR-029: Public API responses exposed internal ownership or private agent fields

- **Status**: Resolved.
- **Symptoms**:
  - Public listing JSON could include internal IDs, ownership data, or private contact fields.
- **Root cause**:
  - Database rows were returned without an explicit public DTO boundary.
- **Repair**:
  - Added explicit public listing DTO mapping.
- **Prevention**:
  - Worker-runtime tests assert that internal ownership and private phone data are absent.

## PP-ERR-030: Uploads lacked complete ownership, quota, and file-signature controls

- **Status**: Resolved in code.
- **Symptoms**:
  - Uploaded objects could become unowned, oversized, incorrectly typed, or difficult to reconcile.
- **Root cause**:
  - Upload validation relied too heavily on filenames or browser-provided metadata.
- **Repair**:
  - Added ownership records, daily quotas, request limits, magic-byte detection, image-header validation, safe content types, and controlled R2 prefixes.
- **Prevention**:
  - File-validator source tests and D1/R2 audit classifications.

## PP-ERR-031: Existing D1 and R2 content had no repeatable integrity audit

- **Status**: Audit implemented; live report review required.
- **Symptoms**:
  - No reliable answer for whether old objects were orphaned, untracked, suspicious, oversized, missing, or referenced incorrectly.
- **Root cause**:
  - Repository tests covered new upload behavior but could not inspect account-bound historical data.
- **Repair**:
  - Added read-only `GET /auth/security/storage-audit`.
  - Added `npm run audit:cloudflare-data`.
  - Reports compare R2 metadata, upload ownership rows, listing media, district images, and avatars.
- **Prevention**:
  - Run after security repairs and periodically before destructive cleanup.
  - Never delete automatically from an audit finding.

## PP-ERR-032: Deployment verifier rejected valid small generated JavaScript files

- **Status**: Resolved.
- **First observed**: Production verification after deployment version `dcb86b6d-5268-424f-8259-369fc35cc86e`.
- **Symptoms**:
  - Deployment succeeded.
  - All pages and assets were present.
  - Verifier reported `Asset body is unexpectedly small` for page-specific generated scripts.
- **Root cause**:
  - `verify-deployment.mjs` assumed every valid asset must be at least 20 characters.
  - Small generated listener files are legitimate and can be shorter than an arbitrary threshold.
- **Repair**:
  - Removed the minimum-size heuristic.
  - Empty bodies still fail.
  - Hashed CSS/JavaScript files are now verified by recomputing SHA-256 and comparing the first 12 hexadecimal characters with the hash embedded in the filename.
- **Prevention**:
  - Static tests reject reintroduction of the old size heuristic.
  - Content identity, status, and content type are checked instead of arbitrary length.
- **Immediate diagnosis**:
  ```bash
  PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" npm run verify:deployment
  ```

## PP-ERR-033: Remote D1/R2 audit returned HTTP 401

- **Status**: Resolved in operator tooling; requires real administrator credentials.
- **Symptoms**:
  - `remote_storage_audit_failed` with status 401.
  - Message: `Administrator authentication required`.
- **Root cause**:
  - The literal string `<current-admin-access-token>` was exported and sent as a bearer token.
  - The prior script did not reject placeholder syntax or provide a temporary login path.
- **Repair**:
  - Audit script rejects angle-bracket placeholders before making a request.
  - It accepts a real current bearer token, or securely supplied `PRIMEPROP_ADMIN_EMAIL` and `PRIMEPROP_ADMIN_PASSWORD` variables.
  - When credentials are supplied, it calls `/auth/login`, confirms the role is `admin`, uses the returned access token in memory, and never logs or persists the token.
  - HTTP 401 now includes targeted remediation.
- **Prevention**:
  - Static tests require placeholder rejection and the temporary administrator login path.
- **Immediate diagnosis and safe execution**:
  ```bash
  cd /absolute/path/to/primeprop-nigeria/worker
  export PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev"
  read -r -p "Administrator email: " PRIMEPROP_ADMIN_EMAIL
  read -r -s -p "Administrator password: " PRIMEPROP_ADMIN_PASSWORD
  echo
  export PRIMEPROP_ADMIN_EMAIL PRIMEPROP_ADMIN_PASSWORD
  npm run audit:cloudflare-data
  unset PRIMEPROP_ADMIN_PASSWORD PRIMEPROP_ADMIN_EMAIL
  ```

## PP-ERR-034: Placeholder repository path was executed literally

- **Status**: Operator error documented and prevented in runbooks.
- **Symptoms**:
  - `cd: no such file or directory: /path/to/primeprop-nigeria`.
- **Root cause**:
  - Documentation placeholder was copied without replacement.
- **Repair**:
  - Use the real absolute repository path.
  - When already inside the repository or `worker/`, do not run the placeholder `cd` command.
- **Prevention**:
  - Runbooks must label placeholders explicitly and prefer commands that print the current directory first.
- **Immediate diagnosis**:
  ```bash
  pwd
  git rev-parse --show-toplevel
  ```

## PP-ERR-035: `cd worker` failed because the shell was already inside `worker/`

- **Status**: Operator error documented.
- **Symptoms**:
  - `cd: no such file or directory: worker` followed by successful npm commands.
- **Root cause**:
  - The prompt already showed the current directory as `worker`, so the command attempted to enter `worker/worker`.
- **Repair**:
  - Confirm the current directory before changing directories.
  - From any nested repository directory, use:
    ```bash
    cd "$(git rev-parse --show-toplevel)/worker"
    ```
- **Prevention**:
  - Future runbooks use repository-root discovery instead of repeated relative `cd worker` instructions.

## PP-ERR-036: Circular loading spinner was inconsistent with page skeleton loading

- **Status**: Resolved in build and runtime.
- **Symptoms**:
  - Agent and administrator loading states used a rotating circular spinner.
  - Other listing pages used skeleton cards.
  - Full-page navigation had no consistent loading treatment.
- **Root cause**:
  - Dashboard HTML retained legacy `.spinner` markup and `@keyframes spin` CSS.
  - Loading behavior evolved independently across pages.
- **Repair**:
  - Strict source preparation replaces every legacy spinner element with accessible skeleton markup before deployment.
  - Legacy spinner CSS and `@keyframes spin` are removed from generated CSS.
  - The strict runtime displays a responsive full-page skeleton for same-origin link navigation and GET form navigation.
  - Back-forward restoration removes stale overlays through `pageshow`.
  - Reduced-motion users receive a nonanimated skeleton.
- **Prevention**:
  - Generated HTML tests reject `.spinner` classes.
  - Generated CSS tests reject `.spinner` rules and `@keyframes spin`.
  - Runtime tests require the shared navigation skeleton implementation.

## PP-ERR-037: Local Wrangler version differed from the version used by CI

- **Status**: Warning recorded; dependency pinning should be reviewed separately before changing the lockfile.
- **Symptoms**:
  - Local output reported Wrangler 4.34.0 with 4.118.0 available.
  - CI used the newer Worker toolchain through the test dependency graph.
- **Root cause**:
  - Wrangler was not a direct top-level development dependency, allowing `npx` or the shell to resolve another installed version.
- **Repair guidance**:
  - Prefer repository scripts over global Wrangler commands.
  - Before a future toolchain upgrade, add Wrangler as a direct exact development dependency and regenerate `package-lock.json` together in one reviewed commit.
  - Do not hand-edit only `package.json`; `npm ci` requires lockfile agreement.
- **Prevention**:
  - Record `npx wrangler --version` in deployment logs.
  - Upgrade the direct dependency and lockfile atomically.

## PP-ERR-038: Duplicate signup could reveal whether an email already existed

- **Status**: Resolved.
- **Symptoms**:
  - Different responses or timing for new and existing emails could enable account enumeration.
- **Root cause**:
  - Duplicate handling was distinguishable.
- **Repair**:
  - Password hashing runs before insert outcome is known.
  - `INSERT OR IGNORE` is used.
  - New and duplicate requests receive the same success shape.
- **Prevention**:
  - Integration tests verify duplicate-signup response safety.

## PP-ERR-039: Public signups could authenticate before approval

- **Status**: Resolved.
- **Symptoms**:
  - A newly registered account could sign in immediately.
- **Root cause**:
  - Signup and login status enforcement were inconsistent.
- **Repair**:
  - Public password signups are created as pending.
  - Login denies pending accounts.
- **Prevention**:
  - Worker and live integration tests cover pending signup behavior.

## PP-ERR-040: Cookie-authenticated writes lacked exact Origin and CSRF enforcement

- **Status**: Resolved.
- **Symptoms**:
  - Browser-authenticated state-changing requests could be exposed to cross-origin request attacks.
- **Root cause**:
  - Authentication alone was treated as sufficient for browser writes.
- **Repair**:
  - Cookie-authenticated writes require an approved exact Origin and matching CSRF state.
  - Bearer-only API clients remain supported without browser cookie state.
- **Prevention**:
  - Worker tests cover rejection and acceptance paths.

---

## Current mandatory validation sequence

From any directory inside the repository:

```bash
cd "$(git rev-parse --show-toplevel)/worker"
npm ci
npm run test:all
```

After deployment:

```bash
PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" \
  npm run verify:deployment
```

For the live read-only D1/R2 audit:

```bash
cd "$(git rev-parse --show-toplevel)/worker"
export PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev"
read -r -p "Administrator email: " PRIMEPROP_ADMIN_EMAIL
read -r -s -p "Administrator password: " PRIMEPROP_ADMIN_PASSWORD
echo
export PRIMEPROP_ADMIN_EMAIL PRIMEPROP_ADMIN_PASSWORD
npm run audit:cloudflare-data
AUDIT_EXIT=$?
unset PRIMEPROP_ADMIN_PASSWORD PRIMEPROP_ADMIN_EMAIL
exit "$AUDIT_EXIT"
```

Exit code `3` from the audit means high-severity findings require human review. It does not mean the audit itself failed, and it must never trigger automatic deletion.
