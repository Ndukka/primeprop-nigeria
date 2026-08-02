# PP-ERR-050 — Normal browser refresh race expired professional sessions

## Status

Fixed on `hotfix/session-refresh-race` and protected by source and Worker-runtime regressions.

## Customer impact

Administrators and agents could be returned to the login page even though their seven-day refresh session was still expected to be valid. The failure normally appeared when the 15-minute access cookie expired and the dashboard issued more than one authenticated request at nearly the same time.

## Root cause

The first request rotated the refresh token and marked the previous session row as revoked. A second request from the same browser could still carry that previous refresh cookie before the browser processed the first response. The reuse detector treated this ordinary concurrency window as theft, revoked the complete token family, cleared authentication cookies, and forced a new login.

## Resolution

The active hardened Worker entrypoint now distinguishes a just-rotated refresh repeated by the same client from a delayed replay:

- a matching duplicate within 15 seconds receives a new 15-minute access cookie only;
- it does not overwrite the newly rotated refresh or CSRF cookies;
- it does not revoke the token family or clear browser authentication;
- delayed or different-client reuse still revokes the family and returns `401`.

## Regression coverage

- `worker/tests/session-refresh-runtime.test.ts` verifies immediate duplicate refreshes remain authenticated and the winner's rotated session remains usable.
- The same runtime suite ages the old rotation beyond the grace period and verifies strict family revocation still occurs.
- `worker/tests/session-refresh-regressions.test.ts` locks the source-level grace and strict-replay boundaries.
