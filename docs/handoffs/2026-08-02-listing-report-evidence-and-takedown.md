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

## Migration

`worker/migrations/0019_listing_report_evidence_and_takedown.sql`

Production and remote D1 remain unchanged until the migration is explicitly applied and the verified deployment wrapper succeeds.
