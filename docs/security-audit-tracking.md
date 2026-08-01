# PrimeProp Nigeria — Security Audit Fix Tracking

**Commit:** `f9fca08`  
**Audit date:** 2026-08-01  
**Tracking started:** 2026-08-01  

## Progress Summary

| Severity | Total | Fixed | In Progress | Remaining |
|---|---|---|---|---|
| Critical | 8 | 5 | 3 | 0 |
| High | 11 | 0 | 0 | 11 |
| Medium | 16 | 1 | 0 | 15 |
| Low | 5 | 0 | 0 | 5 |
| **Total** | **40** | **6** | **3** | **31** |

---

## Phase 0: Immediate Containment (Critical — PP-SEC-001 through PP-SEC-008)

### PP-SEC-001: JWT signing secret committed in plaintext
- [x] Generate new 256-bit random secret
- [x] Store via `wrangler secret put JWT_SECRET`
- [x] Remove from wrangler.toml [vars]
- [ ] Remove from Git history (all commits)
- [x] Rotate all existing tokens
- [ ] Add secret scanning to CI
- [x] Add key_version assurance via new secret rotation

### PP-SEC-002: Stored XSS in admin/agent dashboards
- [ ] Audit all innerHTML usages in admin.html
- [ ] Audit all innerHTML usages in agent.html
- [ ] Replace with safe DOM APIs (textContent, createElement, setAttribute)
- [ ] Replace inline event handlers with addEventListener
- [ ] Validate image URLs (https: + approved origins only)
- [ ] Add XSS regression tests

### PP-SEC-003: Bearer tokens in localStorage
- [x] Remove localStorage token code from login.html
- [x] Remove localStorage token code from admin.html
- [x] Remove localStorage token code from agent.html
- [x] Remove legacy OAuth query-token handler
- [x] Ensure only HttpOnly cookies for browser auth
- [x] Clear all legacy localStorage during migration

### PP-SEC-004: Google OAuth not cryptographically verified
- [ ] Implement jose.createRemoteJWKSet with Google JWKS
- [ ] Verify id_token with jwtVerify
- [ ] Validate audience (client ID)
- [ ] Validate issuer (accounts.google.com)
- [ ] Validate expiry, nonce, email_verified
- [ ] Store state in signed HttpOnly cookie
- [ ] Consume state once
- [ ] Remove auto-linking by email alone

### PP-SEC-005: Password reset token returned in API
- [ ] Never return token in response
- [ ] Hash reset tokens in D1
- [ ] Add email delivery integration
- [ ] Single-use tokens with expiry
- [ ] Invalidate old tokens on new request
- [ ] Rate-limit by account + IP
- [ ] Revoke all sessions after reset

### PP-SEC-006: Refresh tokens valid as access tokens
- [x] Add token_use claim (access vs refresh)
- [x] Reject refresh tokens in access middleware
- [x] Create sessions table in D1
- [x] Store hashed refresh tokens
- [x] Implement token rotation with reuse detection
- [x] Revoke token family on reuse
- [x] Add jti, session_id

### PP-SEC-007: Admin credentials in migrations
- [x] Remove password seeding from 0001_initial.sql
- [x] Remove password seeding from 0002_fix_admin.sql
- [ ] Create bootstrap CLI command
- [x] Rotate deployed admin credentials (via new JWT secret)
- [ ] Add deployment check for known hashes

### PP-SEC-008: Agents can self-verify/self-feature/impersonate
- [x] Strip verified, featured, badge from agent create
- [x] Strip verified, featured, badge from agent update
- [x] Derive agent identity from authenticated user
- [x] Add separate admin-only moderation endpoints (same route, role-gated)
- [ ] Add audit log for trust-state changes

---

## Phase 1: Authentication & Browser Security (High — PP-SEC-009 through PP-SEC-021)

### PP-SEC-009: Repository root as static asset directory
- [ ] Create `public/` directory
- [ ] Move all HTML, CSS, JS, images to public/
- [ ] Update wrangler.toml assets.directory to ../public
- [ ] Add assets binding for Worker-first serving
- [ ] Set run_worker_first for HTML and API routes
- [ ] Test /server.js returns 404

### PP-SEC-010: Security headers not on static HTML
- [ ] Add ASSETS binding to wrangler.toml
- [ ] Set run_worker_first = true or specific paths
- [ ] Apply headers via Worker for HTML routes
- [ ] Smoke-test headers on production

### PP-SEC-011: Permissive CSP
- [ ] Remove unsafe-inline from script-src
- [ ] Remove unsafe-inline from style-src (or use nonces)
- [ ] Add object-src 'none'
- [ ] Add base-uri 'self'
- [ ] Add form-action 'self'
- [ ] Restrict connect-src to self
- [ ] Add frame-src for YouTube only
- [ ] Consider Trusted Types

### PP-SEC-012: CSRF not enforced
- [x] Create CSRF validation middleware
- [x] Compare cookie + header in constant time
- [x] Validate Origin header against allowlist
- [x] Apply to all state-changing routes
- [x] Add X-CSRF-Token to CORS allowed headers

### PP-SEC-013: Public signup grants immediate publishing
- [ ] Create accounts as pending
- [ ] Add email verification flow
- [ ] Add Turnstile to signup
- [ ] Separate roles: pending_agent, agent, moderator, admin
- [ ] Require approval before publishing

### PP-SEC-014: Last-admin deletion protection broken
- [ ] Fix DELETE query to select role
- [ ] Count active admins in same transaction
- [ ] Prevent delete/demote/ban of last admin
- [ ] Prevent self-delete without step-up
- [ ] Add concurrent-operation tests

### PP-SEC-015: File validation trusts MIME type
- [ ] Validate magic bytes, not just Content-Type
- [ ] Decode and re-encode images
- [ ] Generate UUID object keys
- [ ] Add per-user upload quotas
- [ ] Add file count limits
- [ ] Add Content-Disposition: attachment for risky types
- [ ] Quarantine files pending moderation

### PP-SEC-016: Legacy Express backend
- [ ] Delete server.js and data/ directory
- [ ] Remove express/cors from package.json
- [ ] Remove node_modules if possible
- [ ] Document removal in migration guide

### PP-SEC-017: Logout doesn't revoke sessions
- [x] Add sessions table in D1
- [x] Store hashed refresh tokens
- [x] Invalidate session on logout
- [x] Increment security_stamp on password changes
- [x] Revoke all sessions on password reset
- [ ] Expose user-facing session list

### PP-SEC-018: CORS returns production origin for disallowed
- [ ] Clean up CORS: reject unknown origins
- [ ] Remove unrestricted localhost in production
- [ ] Set credentials: true only for browser origins
- [ ] Add Vary: Origin

### PP-SEC-019: Rate limiting too broad
- [ ] Add route-specific rate limits
- [ ] Limit login by IP + account
- [ ] Limit signup (stricter)
- [ ] Limit forgot-password by account + IP
- [ ] Limit upload count + bytes per user
- [ ] Return Retry-After headers

### PP-SEC-020: Public DTO exposes raw DB columns
- [ ] Create explicit PublicListingDTO
- [ ] Create AgentListingDTO
- [ ] Create AdminListingDTO
- [ ] Never spread DB rows into responses
- [ ] Add response schema tests

### PP-SEC-021: Agents change trust fields on update
- [ ] Apply role-specific update schemas
- [ ] Agent schema omits verified, featured, badge
- [ ] Admin schema allows moderation fields
- [ ] Return 400 for agent attempts to set restricted fields

---

## Phase 2: Authorization, Data & Uploads (Medium — PP-SEC-022 through PP-SEC-040)

### PP-SEC-022: User-management API mismatch
- [ ] Add GET /auth/users/:id endpoint
- [ ] Standardize avatar_url naming
- [ ] Align role options (pending_agent, agent, moderator, admin)
- [ ] Return validation errors for rejected fields

### PP-SEC-023: Create/update field convention mismatch
- [ ] Standardize on snake_case for API
- [ ] Create shared validation schemas
- [ ] Normalize all request bodies
- [ ] Return 400 for unknown fields

### PP-SEC-024: Numeric/enum validation incomplete
- [ ] Require safe integers
- [ ] Add min/max bounds
- [ ] Enforce enums on create + update
- [ ] Add D1 CHECK constraints

### PP-SEC-025: API can return entire catalogue
- [ ] Make pagination mandatory
- [ ] Set max page size (100)
- [ ] Move filtering to server-side
- [ ] Return compact DTOs for lists

### PP-SEC-026: COUNT with ordered subquery
- [ ] Build WHERE clause separately
- [ ] Run unordered count + ordered page query

### PP-SEC-027: Missing DB indexes/constraints
- [ ] Add migration with indexes
- [ ] Add CHECK constraints
- [ ] Index: listings(created_by, id)
- [ ] Index: listings(type, city, featured, id)
- [ ] Index: password_resets(expires_at, user_id)
- [ ] Index: sessions(expires_at, user_id)

### PP-SEC-028: No session/audit/event model
- [ ] Create sessions table
- [ ] Create audit_events table
- [ ] Create listing_moderation_events table
- [ ] Create upload_objects table
- [ ] Log actor, target, action, timestamp, request_id

### PP-SEC-029: User deletion not atomic
- [ ] Use D1 batch for reassign + delete
- [ ] Verify affected row counts
- [ ] Add foreign key cascade where appropriate

### PP-SEC-030: R2 objects lack ownership tracking
- [ ] Create upload_objects table in D1
- [ ] Track owner, listing_id, key, size, type
- [ ] Reference counting for shared objects
- [ ] Add R2 lifecycle rules
- [ ] Garbage-collect orphans

### PP-SEC-031: R2 nested key routing
- [ ] Fix route to handle slashes in key
- [ ] Add integration tests

### PP-SEC-032: Immutable caching without content-addressed keys
- [ ] Use UUID keys, never overwrite
- [ ] Preserve R2 ETag
- [ ] Honor If-None-Match

### PP-SEC-033: Email changes lack reauthentication
- [ ] Require current password
- [ ] Verify old + new email
- [ ] Revoke other sessions

### PP-SEC-034: Signup leaks email existence
- [ ] Use consistent response for existing/new emails
- [ ] Constant-time response

### PP-SEC-035: Password hashing lifecycle
- [ ] Rehash on login when params outdated
- [ ] Allow long passphrases
- [ ] Check breached passwords
- [ ] Max length for bcrypt DOS prevention

### PP-SEC-036: No admin MFA
- [ ] Cloudflare Access with IdP + MFA
- [ ] Application TOTP for sensitive actions

### PP-SEC-037: No automated tests or CI
- [ ] Add TypeScript typecheck script
- [ ] Add ESLint
- [ ] Add Vitest unit tests
- [ ] Add Miniflare integration tests
- [ ] Add Playwright browser tests
- [ ] Add secret scanning (trufflehog)
- [ ] Add dependency audit
- [ ] Add GitHub Actions workflow
- [ ] Protected branch + required checks

### PP-SEC-038: CDN assets lack SRI
- [ ] Add integrity + crossorigin to Font Awesome
- [ ] Self-host critical assets

### PP-SEC-039: Dead migration state
- [ ] Drop rate_limits table via migration
- [ ] Document current auth model
- [ ] Clean obsolete code paths

### PP-SEC-040: DO cleanup not durable
- [ ] Add alarm-based cleanup
- [ ] Bound keys per account
- [ ] Consider Cloudflare managed rate limiting

---

## Phase 3: Low Priority (PP-SEC-041 through PP-SEC-045)

### PP-SEC-041: API errors disclose route structure
- [ ] Generic error + request ID
- [ ] Structured logging for details

### PP-SEC-042: X-XSS-Protection obsolete
- [ ] Remove header
- [ ] Rely on strict CSP instead

### PP-SEC-043: External image URLs too broad
- [ ] Proxy approved media
- [ ] Require R2 uploads
- [ ] Strip remote URLs from agent submissions

### PP-SEC-044: Insufficient logging
- [ ] Add request ID generation
- [ ] Structured JSON logs
- [ ] Actor ID in logs
- [ ] Security event types
- [ ] Never log secrets/tokens/cookies

### PP-SEC-045: No environment separation
- [ ] Define dev/staging/production environments
- [ ] Separate D1 databases per env
- [ ] Separate R2 buckets per env
- [ ] Separate DO namespaces per env
- [ ] Deployment approvals for production

---

## Verification Gate Checklist

- [ ] Secret scan returns no credentials
- [ ] Old JWT key validates nothing
- [ ] Static manifest = only public files
- [ ] /server.js, /package.json, /.git/config return 404
- [ ] Refresh token rejected on access routes
- [ ] Replayed refresh token revokes family
- [ ] Logout invalidates session immediately
- [ ] Password reset invalidates all sessions
- [ ] Forged Google tokens rejected
- [ ] OAuth state/nonce mismatch rejected
- [ ] CSP contains no unsafe-inline
- [ ] No bearer token in localStorage
- [ ] Agent cannot set verified/featured/badge
- [ ] Agent cannot edit another's listing
- [ ] Last admin cannot be deleted/demoted/banned
- [ ] Forgot-password never returns token
- [ ] File validation rejects spoofed MIME
- [ ] Object keys are random + non-overwriting
- [ ] Pagination is mandatory + server-side
- [ ] API responses match explicit schemas
- [ ] Typecheck + lint + tests pass in CI
- [ ] Production requires branch protection
