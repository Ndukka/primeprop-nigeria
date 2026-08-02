# PrimeProp Nigeria Error Bank

This is the permanent operational and engineering error bank for PrimeProp Nigeria. Update it whenever a defect, failed deployment, unsafe configuration, misleading test, or repeatable operator mistake is discovered.

The file exists to make recurrence inexpensive: a future engineer should be able to match the symptom, identify the root cause, apply the established repair, and run the prevention gate without rediscovering the incident.

## Maintenance rules

1. Never delete a resolved incident. Mark it resolved and add superseding information.
2. Add a new entry when the root cause differs, even if the visible symptom is similar.
3. Update an existing entry when the root cause and repair are the same.
4. Record symptoms, root cause, affected files, repair, prevention, and immediate diagnostics.
5. A hard refresh, cache purge, restart, retry, or temporary CSP relaxation is not a root-cause repair.
6. Temporary compatibility code must have a removal entry and a regression test.
7. Never describe production D1 or R2 data as clean until the live audit report has been run and reviewed.
8. Never copy placeholder paths, tokens, email addresses, passwords, IDs, or secrets into executable commands.
9. Deployment repairs must pass `npm run test:all` and `npm run verify:deployment` after release.
10. Never weaken CSP, authentication, authorization, validation, migrations, or tests merely to make a gate pass.

## Required entry fields

- **Status**: Open, mitigated, resolved, or owner action required.
- **Symptoms**: What the user, browser, test, or operator observed.
- **Root cause**: The technical reason the failure occurred.
- **Repair**: The exact code, configuration, migration, or process correction.
- **Prevention**: The automated or procedural control that blocks recurrence.
- **Immediate diagnosis**: The shortest reliable check when relevant.

---

## PP-ERR-001: Normal navigation produced an unstyled page

- **Status**: Resolved in source; the latest branch must be deployed.
- **Symptoms**: A page appeared without layout or CSS, hard refresh repaired it, and the problem returned after clicking another page.
- **Root cause**: Relative, unversioned asset URLs allowed browser navigation or back-forward cache to reuse HTML from one revision while loading assets from another revision.
- **Repair**: `public/` is source only; `build-public.mjs` emits `dist-public/`; local CSS and JavaScript are content-hashed under `/assets/`; references are root-absolute; pages and `asset-manifest.json` share build identities; HTML is `private, no-store`; hashed assets are immutable; stable aliases revalidate; `.html` and trailing-slash variants redirect to clean canonical URLs.
- **Prevention**: Strict build of all 14 pages, manifest validation, live Wrangler route tests, and the post-deployment verifier.
- **Immediate diagnosis**:
  ```bash
  PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" npm run verify:deployment
  ```

## PP-ERR-002: Required static asset returned 404

- **Status**: Resolved.
- **Symptoms**: Browser console showed failed `/styles.css` or script requests and the page rendered as plain HTML.
- **Root cause**: Static publication was not proven by executable HTTP tests and the asset directory could drift from route behavior.
- **Repair**: Wrangler deploys generated `dist-public/`; stable aliases are generated; integration tests request actual CSS and JavaScript over HTTP.
- **Prevention**: Manifest-driven checks verify every referenced hashed asset and the stable aliases.

## PP-ERR-003: CSP blocked inline style attributes

- **Status**: Resolved.
- **Symptoms**: CSP errors for `style="..."`; layout, visibility, positioning, or fallback appearance failed.
- **Root cause**: Pages still contained inline style attributes while strict CSP blocked style attributes.
- **Repair**: Static style attributes compile to generated CSS classes; JavaScript visual state uses nonce-authorized stylesheet rules; CSP uses `style-src-attr 'none'`.
- **Prevention**: Generated HTML and JavaScript are rejected if inline style markup remains.

## PP-ERR-004: JavaScript `.style` assignments violated strict CSP policy

- **Status**: Resolved.
- **Symptoms**: Runtime hide/show/position changes failed or strict bundle checks rejected scripts.
- **Root cause**: Code assigned `element.style.property` directly.
- **Repair**: Supported assignments are rewritten through `PrimePropStyles.set`, which inserts nonce-authorized rules and applies classes.
- **Prevention**: Every generated JavaScript file is scanned for `.style`, bracket access, and direct style assignment.

## PP-ERR-005: Font Awesome fonts were blocked

- **Status**: Resolved.
- **Symptoms**: Icons appeared as blank squares even though Font Awesome CSS loaded.
- **Root cause**: `font-src` omitted the cdnjs font origin.
- **Repair**: Added `https://cdnjs.cloudflare.com` to `font-src`.
- **Prevention**: Security-header tests assert approved font origins.

## PP-ERR-006: Nonce attributes were duplicated

- **Status**: Resolved.
- **Symptoms**: A script or style element contained multiple nonce attributes and CSP behavior became uncertain.
- **Root cause**: Nonce injection appended a value without removing the existing attribute.
- **Repair**: Existing nonce attributes are removed and replaced exactly once.
- **Prevention**: Security-header tests verify replacement semantics.

## PP-ERR-007: Inline event attributes were blocked

- **Status**: Resolved.
- **Symptoms**: Forms, filters, pagination, favorites, uploads, lightboxes, and dashboard controls looked clickable but did nothing.
- **Root cause**: HTML and generated markup still used `onclick`, `onchange`, `oninput`, `onerror`, or related attributes while CSP used `script-src-attr 'none'`.
- **Repair**: Static handlers compile into external listener files; dynamic actions use declarative `data-pp-*` attributes and direct listeners.
- **Prevention**: The build fails when any inline event attribute remains.

## PP-ERR-008: Replacing `.onclick` with ordinary listeners stacked handlers

- **Status**: Resolved.
- **Symptoms**: Dashboard controls executed multiple or obsolete actions after tab changes.
- **Root cause**: `addEventListener` accumulates listeners and does not reproduce event-property replacement semantics.
- **Repair**: `PrimePropEvents.replace` removes the previous listener for the target/event pair before attaching the replacement.
- **Prevention**: Event-property assignments are rejected by the build; runtime tests require the replacement registry.

## PP-ERR-009: Temporary CSP compatibility bridge became production coupling

- **Status**: Resolved and removed.
- **Symptoms**: Production depended on `/js/csp-events.js` and `/csp-compat.css`.
- **Root cause**: A temporary bridge remained after the migration was complete.
- **Repair**: All style and event behavior is compiled or attached directly; both files were deleted.
- **Prevention**: Source, integration, and deployment tests require both retired URLs to return 404.

## PP-ERR-010: Rewritten HTML retained stale validators

- **Status**: Resolved.
- **Symptoms**: ETag, Last-Modified, Content-Length, or cache metadata described the original asset after nonce injection changed the body.
- **Root cause**: Static response metadata was preserved after mutation.
- **Repair**: Rewritten HTML removes those headers and receives `private, no-store, max-age=0` plus `Pragma: no-cache`.
- **Prevention**: Live tests verify HTML cache policy and response shape.

## PP-ERR-011: Trailing slash changed protected route behavior

- **Status**: Resolved.
- **Symptoms**: `/auth/path` and `/auth/path/` behaved differently or bypassed exact routing logic.
- **Root cause**: Normalization happened after security-sensitive route decisions or not at all.
- **Repair**: Production entry normalizes API/auth paths before dispatch; public variants redirect to canonical clean URLs.
- **Prevention**: Integration tests exercise canonical and noncanonical forms.

## PP-ERR-012: OAuth redirect validation used substring matching

- **Status**: Resolved.
- **Symptoms**: A malicious hostname containing an approved word could pass validation.
- **Root cause**: Validation checked substrings rather than exact protocol, origin, and callback path.
- **Repair**: Exact redirect-origin and callback-path policy is enforced.
- **Prevention**: OAuth routing tests include invalid variants.

## PP-ERR-013: OAuth verifier errors leaked details

- **Status**: Resolved.
- **Symptoms**: User-visible responses exposed provider or verification exception text.
- **Root cause**: Raw verifier failures were returned to the client.
- **Repair**: Detailed errors are logged internally and public responses use controlled generic messages.
- **Prevention**: Production callback wrapper normalizes verifier failures.

## PP-ERR-014: New Google users bypassed pending approval

- **Status**: Resolved.
- **Symptoms**: OAuth-created users entered the application immediately while password signups remained pending.
- **Root cause**: OAuth account creation used a separate status path.
- **Repair**: New Google identities are forced to pending; cookies are cleared; database safeguards reinforce the rule.
- **Prevention**: Migration and runtime tests cover pending OAuth identities.

## PP-ERR-015: Password-reset token was logged in plaintext

- **Status**: Resolved.
- **Symptoms**: A usable reset credential could appear in Worker logs.
- **Root cause**: Development token logging remained in production code.
- **Repair**: Tokens are never logged or returned; only SHA-256 hashes are stored.
- **Prevention**: Static review and recovery-flow tests.

## PP-ERR-016: Password reset was generated but not delivered

- **Status**: Resolved in code; provider setup is owner-controlled.
- **Symptoms**: Recovery appeared successful but no usable email arrived.
- **Root cause**: Reset records existed without a production delivery path.
- **Repair**: Resend delivery, single-use 15-minute links, and fail-closed configuration checks were added; failed delivery deletes the record.
- **Prevention**: Production must configure `RESEND_API_KEY`, `PASSWORD_RESET_FROM`, and public URL settings.

## PP-ERR-017: Existing access tokens survived account-security changes

- **Status**: Resolved.
- **Symptoms**: Old tokens remained valid after password, email, role, or status changes.
- **Root cause**: Validity depended only on JWT signature and expiry.
- **Repair**: Added D1-backed security-stamp invalidation epochs and rotation triggers.
- **Prevention**: Migration `0013_session_invalidation.sql` and runtime tests.

## PP-ERR-018: Silent refresh omitted the current role

- **Status**: Resolved.
- **Symptoms**: Refreshed access tokens could contain an undefined or stale role.
- **Root cause**: The D1 refresh query did not select `role` but later read it.
- **Repair**: Refresh loads current identity, role, status, and security state from D1.
- **Prevention**: Worker-runtime refresh tests.

## PP-ERR-019: Refresh rotation was not meaningfully tested

- **Status**: Resolved.
- **Symptoms**: Source looked correct but no Worker-bound test proved token-family behavior.
- **Root cause**: Earlier tests ran in an incompatible environment without actual bindings.
- **Repair**: Added isolated Worker tests for access/refresh separation, sessions, rotation, and reuse handling.
- **Prevention**: Node, Worker, and live HTTP suites remain separate.

## PP-ERR-020: Final active administrator could be removed

- **Status**: Resolved.
- **Symptoms**: Demotion, banning, or deletion could leave no active administrator.
- **Root cause**: Application checks were incomplete and bypassable through alternate writes.
- **Repair**: Database triggers in `0012_account_safety.sql` enforce the invariant; application checks provide clear messages.
- **Prevention**: Migration tests require `prevent_last_active_admin`.

## PP-ERR-021: Fresh migrations failed because a retired migration was comments-only

- **Status**: Resolved.
- **Symptoms**: Empty-database migration runs failed at `0002_fix_admin.sql`.
- **Root cause**: Immutable migration history was emptied instead of retained as valid SQL.
- **Repair**: The migration is a safe `SELECT 1;` no-op.
- **Prevention**: Every integration run applies the complete catalogue to an empty local D1 database.

## PP-ERR-022: Node and Worker tests shared an invalid Vitest environment

- **Status**: Resolved.
- **Symptoms**: Tests passed without bindings or failed unpredictably due to runtime mismatch.
- **Root cause**: Node source checks and Cloudflare Worker execution used one configuration.
- **Repair**: Split Node static, Worker-pool, and live Wrangler suites.
- **Prevention**: `npm run test:all` executes each environment explicitly.

## PP-ERR-023: No mandatory end-to-end CI gate

- **Status**: Resolved.
- **Symptoms**: A branch could appear complete without typecheck, runtime, migration, or HTTP asset proof.
- **Root cause**: Validation was local and informal.
- **Repair**: Security CI runs dependency install, TypeScript, strict build, Worker runtime, migrations, and live HTTP tests.
- **Prevention**: Do not merge without a green current-head Security CI run.

## PP-ERR-024: GitHub Actions used mutable tags

- **Status**: Resolved.
- **Symptoms**: CI behavior could change without a repository commit.
- **Root cause**: Workflow actions referenced floating tags.
- **Repair**: Actions are pinned to exact commit SHAs.
- **Prevention**: Review action SHA changes as dependencies.

## PP-ERR-025: Administrator credentials were published in documentation

- **Status**: Resolved; any previously used credential must be rotated.
- **Symptoms**: API documentation contained administrator credentials.
- **Root cause**: Setup examples used live-looking values.
- **Repair**: Credentials were removed and documentation describes secure provisioning only.
- **Prevention**: Static tests reject the retired credential pattern.

## PP-ERR-026: JWT signing secret was committed in Wrangler

- **Status**: Resolved; rotation remains owner-controlled.
- **Symptoms**: Source configuration contained a signing secret.
- **Root cause**: Secret and non-secret configuration were not separated.
- **Repair**: Secret removed from `wrangler.toml`; Wrangler/Secrets Store is required.
- **Prevention**: Static tests reject literal `JWT_SECRET` values.

## PP-ERR-027: Legacy Express backend remained beside the Worker

- **Status**: Resolved in the audited base commit.
- **Symptoms**: Duplicate production backends created uncertain security and routing ownership.
- **Root cause**: Worker migration did not remove the retired server.
- **Repair**: Legacy Express backend removed.
- **Prevention**: Wrangler defines the single production entry point.

## PP-ERR-028: Deployment scope could expose unintended files

- **Status**: Resolved.
- **Symptoms**: Repository files outside the browser application could enter the asset context.
- **Root cause**: Static publication scope was too broad.
- **Repair**: Only generated `dist-public/` is deployable.
- **Prevention**: Wrangler source tests assert the directory.

## PP-ERR-029: Public DTO exposed internal or private fields

- **Status**: Resolved.
- **Symptoms**: Public listing JSON could include ownership IDs or private agent information.
- **Root cause**: Raw database rows crossed the public API boundary.
- **Repair**: Explicit public DTO mapping was added.
- **Prevention**: Worker tests assert private fields are absent.

## PP-ERR-030: Uploads lacked complete ownership and file validation

- **Status**: Resolved in code.
- **Symptoms**: Objects could be unowned, oversized, incorrectly typed, or difficult to reconcile.
- **Root cause**: Validation relied too heavily on browser metadata and filenames.
- **Repair**: Added ownership rows, quotas, request limits, magic-byte detection, image-header validation, approved content types, and controlled prefixes.
- **Prevention**: Validator tests and D1/R2 audit classifications.

## PP-ERR-031: Historical D1/R2 data had no repeatable integrity audit

- **Status**: Audit implemented; live report review remains required.
- **Symptoms**: No reliable answer for orphaned, untracked, suspicious, oversized, missing, or incorrectly referenced media.
- **Root cause**: Repository tests cannot inspect account-bound historical data.
- **Repair**: Added read-only `GET /auth/security/storage-audit` and `npm run audit:cloudflare-data` comparing R2 metadata, upload rows, listings, districts, and avatars.
- **Prevention**: Run before destructive cleanup; never delete automatically from audit output.

## PP-ERR-032: Verifier rejected legitimate small generated scripts

- **Status**: Resolved.
- **First observed**: Deployment version `dcb86b6d-5268-424f-8259-369fc35cc86e`.
- **Symptoms**: Deployment succeeded, but verification reported `Asset body is unexpectedly small` for two page-specific JavaScript files.
- **Root cause**: The verifier assumed every valid asset must exceed 20 characters.
- **Repair**: Removed the arbitrary threshold; empty bodies fail; hashed CSS/JS bodies are SHA-256 checked against the 12-character filename hash.
- **Prevention**: Static tests reject the old heuristic and require content-hash verification.

## PP-ERR-033: Remote storage audit returned HTTP 401

- **Status**: Resolved in tooling; real administrator credentials are still required.
- **Symptoms**: `remote_storage_audit_failed`, status 401, `Administrator authentication required`.
- **Root cause**: Literal `<current-admin-access-token>` placeholder was sent as the bearer token.
- **Repair**: Script rejects angle-bracket placeholders; accepts a real bearer or prompts interactively for administrator email/password; logs in, verifies the admin role, keeps the token in memory, and never logs or persists it.
- **Prevention**: Static tests require placeholder rejection, interactive login, and secret-output checks.

## PP-ERR-034: Placeholder repository path was executed literally

- **Status**: Operator error documented.
- **Symptoms**: `cd: no such file or directory: /path/to/primeprop-nigeria`.
- **Root cause**: A documentation placeholder was copied unchanged.
- **Repair**: Use repository discovery rather than sample paths.
- **Prevention**:
  ```bash
  git rev-parse --show-toplevel
  cd "$(git rev-parse --show-toplevel)/worker"
  ```

## PP-ERR-035: `cd worker` failed while already inside `worker/`

- **Status**: Operator error documented.
- **Symptoms**: `cd: no such file or directory: worker`, while npm commands still ran successfully.
- **Root cause**: The command attempted to enter `worker/worker`.
- **Repair**: Resolve the directory from Git root instead of chaining relative `cd` commands.
- **Prevention**: Run `pwd` and use `cd "$(git rev-parse --show-toplevel)/worker"`.

## PP-ERR-036: Circular loaders were inconsistent with skeleton loading

- **Status**: Resolved in build and runtime.
- **Symptoms**: Agent/admin pages used rotating `.spinner` elements; some placeholders used Font Awesome `fa-spinner`; listing pages used skeleton cards; full-page navigation was inconsistent.
- **Root cause**: Loader patterns evolved independently and the first conversion covered only CSS spinner divs, not icon and generated-script variants.
- **Repair**: Strict source preparation replaces `.spinner`, `fa-spinner`, and dynamically generated spinner markup with accessible skeletons; removes `.spinner` CSS and `@keyframes spin`; navigation uses a responsive full-page skeleton; `pageshow` clears stale overlays; reduced-motion users receive a static skeleton.
- **Prevention**: Generated HTML rejects `spinner` and `fa-spinner`; generated CSS rejects spinner rules/keyframes; runtime tests require shared skeleton behavior.

## PP-ERR-037: Local deployment used a different Wrangler version than CI

- **Status**: Resolved.
- **Symptoms**: Local `npm run deploy` used Wrangler 4.34.0 while CI and Worker integration used 4.118.0.
- **Root cause**: Wrangler was transitive rather than a direct command dependency, so the shell resolved an older global CLI.
- **Repair**: `run-wrangler.mjs` resolves the repository-installed tested package, requires exact version 4.118.0, refuses any other version, and is used by `dev`, `deploy`, and D1 migration scripts.
- **Prevention**: Static tests reject bare `wrangler deploy` and require the exact-version runner.
- **Immediate diagnosis**:
  ```bash
  npm run deploy -- --dry-run
  ```
  Confirm the first JSON line reports `primeprop_wrangler_selected` with version `4.118.0`.

## PP-ERR-038: Duplicate signup leaked account existence

- **Status**: Resolved.
- **Symptoms**: Different behavior for new and existing email addresses could enable enumeration.
- **Root cause**: Duplicate handling was distinguishable.
- **Repair**: Password hashing occurs before insert outcome; `INSERT OR IGNORE` is used; new and duplicate attempts receive the same success shape.
- **Prevention**: Live integration tests verify enumeration-safe behavior.

## PP-ERR-039: Public signup could authenticate before approval

- **Status**: Resolved.
- **Symptoms**: Newly registered users could sign in immediately.
- **Root cause**: Signup and login status enforcement were inconsistent.
- **Repair**: Public password and Google-created accounts are pending; login denies pending users.
- **Prevention**: Worker and live integration tests cover pending behavior.

## PP-ERR-040: Cookie-authenticated writes lacked exact Origin and CSRF checks

- **Status**: Resolved.
- **Symptoms**: Browser-authenticated writes were exposed to cross-origin request risk.
- **Root cause**: Authentication was treated as sufficient for browser state changes.
- **Repair**: Cookie writes require an approved exact Origin and matching CSRF state; bearer-only API clients remain supported.
- **Prevention**: Worker tests cover rejection and acceptance paths.

## PP-ERR-041: Legacy JavaScript history link became `/javascript:history.back()`

- **Status**: Resolved.
- **Symptoms**: The property-detail “Back to listings” control could navigate to an invalid `/javascript:history.back()` path instead of returning to the previous page.
- **Root cause**: A legacy `href="javascript:history.back()"` survived in generated markup; root-absolute URL rewriting treated it as a relative path and prefixed `/`.
- **Repair**: Strict source preparation converts legacy history links to `href="/properties" data-pp-action="back"`; the strict runtime calls `history.back()` when history exists and uses `/properties` as a real fallback.
- **Prevention**: Generated-page tests reject all `javascript:` URLs and the specific rewritten form; runtime tests require the safe back action.

## PP-ERR-042: Navigation skeleton could hijack nested interactive controls

- **Status**: Resolved.
- **Symptoms**: Clicking a favorite, lightbox control, button, or other interactive child inside an anchor could display the full-page skeleton and navigate before the component handler finished.
- **Root cause**: The first navigation listener ran in capture phase, before target handlers could call `preventDefault()` or `stopPropagation()`.
- **Repair**: Navigation interception runs in bubble phase; it ignores buttons, inputs, selects, textareas, role buttons, `data-pp-action`, and stop-propagation controls; only genuine same-origin page navigation is intercepted.
- **Prevention**: Static tests require the interactive-target exclusion and prohibit regressions to unsafe page interception.

## PP-ERR-043: Post-deployment verification observed mixed Worker asset revisions

- **Status**: Resolved in deployment tooling; the corrected branch must be redeployed.
- **First observed**: Deployment version `838d5f04-8553-4081-b786-92bd5fdef870`.
- **Symptoms**: `asset-manifest.json` described the new 14-page build, while `/`, `/login`, and `/reset-password` returned HTML with different build IDs; hashed runtime and login CSS requests returned 404 immediately after deployment.
- **Root cause**: The deploy used an older global Wrangler version, and the one-shot verifier sampled requests while Cloudflare edge locations were converging on the new Worker/static-asset unit. A single mixed round was reported as a permanent release failure.
- **Repair**: Operator commands now use exact tested Wrangler 4.118.0. The verifier adds unique cache-busting query parameters, sends no-cache/no-store headers, records `cf-ray` on failures, retries bounded rounds, and requires two consecutive clean rounds with the same manifest identity before declaring success.
- **Prevention**: Use `npm run deploy:verified` with `PRIMEPROP_BASE_URL` set. Never accept one successful request or one failing request as proof of global deployment coherence.
- **Immediate diagnosis**:
  ```bash
  PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" \
    npm run verify:deployment
  ```

## PP-ERR-044: Bash `read -p` audit instructions failed in zsh

- **Status**: Resolved.
- **Symptoms**: zsh printed `read: -p: no coprocess`; email/password variables remained empty; the audit exited 2 with `Administrator authentication is required`.
- **Root cause**: `read -p` is Bash prompt syntax but has different meaning in zsh.
- **Repair**: `audit-cloudflare-data.mjs` owns the interactive prompt. It reads the email, disables terminal echo for the password, restores terminal mode, supports Ctrl-C, and works independently of the invoking shell.
- **Prevention**: Run the Node command directly. Static tests prohibit reintroducing shell-specific `read -p` instructions.
- **Immediate diagnosis and execution**:
  ```bash
  PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" \
    npm run audit:cloudflare-data
  ```

## PP-ERR-045: Remote D1 trigger migration failed and the shell still deployed

- **Status**: Resolved and deployed on 2026-08-02.
- **Symptoms**: Remote migration `0018_feedback_and_reviewer_identities.sql` failed with `incomplete input: SQLITE_ERROR [code: 7500]`, but the surrounding shell continued into `deploy:verified` and published Worker code before its required tables were available.
- **Root cause**: D1's remote SQL parser misread unparenthesized `CASE ... END` expressions inside trigger bodies. The operator command sequence did not fail closed after the migration process returned a nonzero status.
- **Repair**: Trigger expressions are written as `SELECT (CASE ... END)`; `release-production-verified.mjs` lists and applies remote migrations, verifies that none remain, and only then invokes the verified deployment.
- **Prevention**: The full isolated migration catalogue must pass with Wrangler 4.118.0; production releases must use `npm run release:production:verified`; tests require the parenthesized trigger form and migration-before-deployment ordering.
- **Immediate diagnosis**:
  ```bash
  cd "$(git rev-parse --show-toplevel)/worker"
  node ./scripts/run-wrangler.mjs d1 migrations list primeprop-db --remote
  ```

## PP-ERR-046: Recent feedback code appeared only after repeated hard refreshes

- **Status**: Resolved in source; deploy the current hotfix through the fail-closed release command.
- **First observed**: After production Worker version `24aaf68e-5b50-456e-a588-8063845bb7d1`.
- **Symptoms**: Newly deployed rating, reporting, or administrator feedback code remained absent during ordinary navigation or reloads and appeared only after a hard refresh. The problem returned because different browser requests could reuse different revisions.
- **Root cause**: The recent feedback loader introduced unversioned dynamically loaded feedback scripts under `/js/*.js` while the page, manifest, and ordinary scripts used content-hashed `/assets/*` URLs. Rewritten HTML also relied on inherited cache metadata instead of explicitly removing validators and enforcing the documented no-store policy.
- **Repair**: `version-dynamic-runtime-assets.mjs` replaces every dynamic feedback URL in generated `client-data` with its manifest-owned content-hashed URL, re-hashes `client-data`, updates every page reference and build identity, and rewrites the manifest before compatibility aliases are copied. `setHtmlSecurityHeaders` now deletes `ETag`, `Last-Modified`, `Content-Length`, `Age`, and surrogate cache metadata and always sets `private, no-store, max-age=0, must-revalidate`, `Pragma: no-cache`, and `Expires: 0`.
- **Prevention**: Cache-coherency tests require every deployable page script and every dynamic feedback runtime to use a 12-character content hash; the build fails if a stable feedback URL remains; security-header tests require validator removal; post-deployment verification continues to require no-store HTML and two stable manifest rounds.
- **Immediate diagnosis**:
  ```bash
  cd "$(git rev-parse --show-toplevel)/worker"
  npm run build:public
  ```
  Confirm `dynamic_runtime_assets_versioned` is printed and the static test suite reports no unversioned runtime URL.

---

## Mandatory validation sequence

From any directory inside the repository:

```bash
cd "$(git rev-parse --show-toplevel)/worker"
npm ci
npm run test:all
```

Apply migrations, deploy, and require stable post-deployment verification:

```bash
cd "$(git rev-parse --show-toplevel)/worker"
PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" \
  npm run release:production:verified
```

Run the live read-only D1/R2 audit. The script prompts for credentials in the terminal and does not echo the password:

```bash
cd "$(git rev-parse --show-toplevel)/worker"
PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" \
  npm run audit:cloudflare-data
```

Audit exit code `3` means high-severity findings require human review. It does not mean the audit transport failed and must never trigger automatic deletion.
