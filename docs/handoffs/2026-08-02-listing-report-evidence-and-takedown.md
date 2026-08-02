# Listing report evidence and takedown extension

## Scope

This extension builds on the separated Google reviewer subsystem introduced by PR #14.

- Every approved listing retains a private **Report this listing** action.
- The report stores a snapshot of the verified Google email used at submission.
- It records Cloudflare's trusted client IP, country, sanitized browser signature and CF-Ray request ID for administrator-only investigation.
- It does not trust `X-Forwarded-For` as the reporter address.
- It stores a keyed HMAC fingerprint for abuse-pattern correlation.
- Exact network evidence is removed 90 days after a report is resolved or dismissed; the fingerprint remains.
- Google `sub`, access tokens and refresh tokens are never exposed to administrators or public clients.
- No broader Google profile scope is requested.

## Administrator workflow

The Feedback > Reports table provides:

- Reporter details: verified Google email snapshot, current email, verification state, first/last authentication, IP, country, browser signature, request ID and retention state.
- Investigate, resolve and dismiss actions.
- **Take down listing** for listing reports only.

Takedown is reversible and non-destructive. The listing is changed from `approved` to `pending`; the row and all listing data remain. An administrator can reapprove the listing from the Listings tab after review.

The listing status change, report resolution and two audit events execute in one D1 batch transaction.

## Migrations

- `worker/migrations/0018_feedback_and_reviewer_identities.sql`
- `worker/migrations/0019_listing_report_evidence_and_takedown.sql`

The first remote attempt on August 2, 2026 failed before either migration was recorded because D1's remote trigger parser misread unparenthesized `CASE ... END` expressions inside migration `0018`, returning `incomplete input: SQLITE_ERROR [code: 7500]`.

Migration `0018` now uses `SELECT (CASE ... END)` in every trigger branch. This keeps the same database constraints while avoiding the known remote parser ambiguity. A failed D1 migration is expected to roll back; always verify the remote migration list before retrying.

## Google callback configuration

The current reviewer callback is:

```text
https://primeprop-worker.ndupsn.workers.dev/auth/feedback/google/callback
```

The supported future main-domain callback is:

```text
https://primeprop.ng/auth/feedback/google/callback
```

The Google-authorized redirect URI and the Worker value must match exactly. Configure the Worker from `worker/` with:

```bash
node ./scripts/run-wrangler.mjs secret put GOOGLE_FEEDBACK_REDIRECT_URI
```

Do not use the origin alone as the callback, do not add a trailing slash, and do not put the value directly in the command line. Full instructions are in:

`docs/runbooks/google-feedback-redirect-and-production-release.md`

## Production release

Use only:

```bash
PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" \
  npm run release:production:verified
```

The release command applies remote migrations, verifies that none remain, and only then deploys and verifies the Worker. Any migration error prevents deployment.

Do not manually continue to `deploy:verified` after a migration failure.

Production activation is complete only when the output includes:

```text
primeprop_production_release_passed
primeprop_deployment_verification_passed
```

and the deployment verifier reports:

```json
"failures": []
```
