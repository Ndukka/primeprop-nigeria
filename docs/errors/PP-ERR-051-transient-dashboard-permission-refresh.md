# PP-ERR-051 — Dashboard refresh reached role enforcement before session renewal

## Status

Fixed on `hotfix/admin-session-bootstrap`; production activation requires merge and the verified release command.

## Customer impact

An authenticated administrator could open the Districts or Users area and briefly receive HTTP 403 with:

`Insufficient permissions. This action requires: admin`

A later retry or another dashboard request could succeed without any role or database change. The agent dashboard had the same underlying exposure on its profile and listing bootstrap requests.

## Root causes

1. The hardened session preflight did not cover several authenticated GET routes, including administrator inventory endpoints and the agent profile-settings endpoint.
2. Those requests could fall through to the legacy authentication middleware with only the seven-day refresh cookie available.
3. The legacy fallback query selected `id`, `account_status`, and `security_stamp`, then read `dbUser.role` even though `role` was not selected. The request therefore reached role enforcement as an authenticated user with an undefined role and returned 403.
4. Both dashboard pages retain a legacy bootstrap and a correction runtime, so related reads can start nearly together when the 15-minute access cookie has expired. That concurrency made the incorrect fallback visible intermittently; it did not represent an actual role change.

## Resolution

The production Worker now has one professional-session entry boundary before route-specific authentication and authorization. It covers all current protected administrator and agent dashboard routes, protected upload reads, and authenticated API writes.

When the access cookie is absent, expired, invalidated, or stale, the boundary:

- resolves the session through the hardened `/auth/session` path;
- rotates or reuses the refresh family according to PP-ERR-050;
- forwards the renewed access cookie into the original request;
- forwards the renewed CSRF proof for state-changing requests;
- preserves all returned authentication cookies for the browser;
- leaves role enforcement to the underlying route using the current database role.

Public listing, public profile, Google reviewer, and public feedback routes remain outside this professional-session boundary.

## Client-dashboard coverage

Worker-runtime tests start the real first-load request pairs with only refresh and CSRF cookies:

- administrator: `/auth/admin-districts` and `/auth/admin-users` concurrently;
- agent: `/auth/profile-settings` and `/auth/my-listings` concurrently.

Both responses must succeed, produce a renewed access cookie, and never clear the winning refresh or CSRF cookie.

## Immediate diagnosis

From the repository:

```bash
cd "$(git rev-parse --show-toplevel)/worker"
npm run test:worker -- --run tests/session-refresh-runtime.test.ts
```

In the browser Network panel, inspect the first failed dashboard request. A 403 followed by a successful request without an account-role change indicates an old deployment or a protected route missing from the professional-session boundary. A genuine non-admin request should continue returning 403 consistently.

## Prevention

- Source regression coverage locks the protected-route catalogue and the `/auth/session` forwarding behavior.
- Worker-runtime coverage exercises concurrent administrator and agent dashboard bootstraps.
- Root `errors.md` contains PP-ERR-049, PP-ERR-050, and PP-ERR-051 so the latest feedback and session incidents remain searchable from one permanent bank.
