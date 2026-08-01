-- Migration: 0008_sessions.sql
-- PP-SEC-006: Add sessions table for refresh token tracking, rotation, and revocation.
-- PP-SEC-028: Foundation for audit events and security-event tracking.

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,             -- SHA-256 hash of the refresh token
  token_family TEXT NOT NULL,           -- Family ID: regenerated on full revocation
  token_jti TEXT NOT NULL,              -- JWT ID of the most recent refresh token
  user_agent TEXT DEFAULT '',           -- Browser/device fingerprint
  ip_address TEXT DEFAULT '',           -- Client IP at creation
  expires_at INTEGER NOT NULL,          -- Unix timestamp (milliseconds)
  rotated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  revoked INTEGER NOT NULL DEFAULT 0   -- 0=active, 1=revoked
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- PP-SEC-017: Add security_stamp to users for global session invalidation
ALTER TABLE users ADD COLUMN security_stamp TEXT DEFAULT '';

-- PP-SEC-028: Audit events table for security-sensitive actions
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,                     -- User who performed the action (NULL for system)
  actor_email TEXT DEFAULT '',
  action TEXT NOT NULL,                 -- e.g. 'user.created', 'listing.verified', 'session.revoked'
  target_type TEXT DEFAULT '',          -- e.g. 'user', 'listing', 'session'
  target_id INTEGER,                    -- ID of the affected resource
  details TEXT DEFAULT '{}',            -- JSON: before/after values (never secrets)
  request_id TEXT DEFAULT '',
  ip_address TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_events(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action, created_at);
