-- Migration: 0013_session_invalidation.sql
-- Adds a monotonic invalidation timestamp so access JWTs issued before a
-- security-sensitive account change can be rejected immediately.

ALTER TABLE users ADD COLUMN security_stamp_changed_at INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET security_stamp = lower(hex(randomblob(16)))
WHERE security_stamp IS NULL OR security_stamp = '';

CREATE TRIGGER IF NOT EXISTS trg_security_stamp_timestamp
AFTER UPDATE OF security_stamp ON users
WHEN NEW.security_stamp <> OLD.security_stamp
BEGIN
  UPDATE users
  SET security_stamp_changed_at = unixepoch() * 1000,
      updated_at = datetime('now')
  WHERE id = NEW.id;
END;

-- Password, email, role, and account-status changes are security boundaries.
-- Rotating the stamp invalidates every access and refresh token issued before
-- the update, even when a handler forgets to revoke sessions explicitly.
CREATE TRIGGER IF NOT EXISTS trg_rotate_security_stamp_on_sensitive_update
AFTER UPDATE OF password_hash, email, role, account_status ON users
WHEN COALESCE(NEW.password_hash, '') <> COALESCE(OLD.password_hash, '')
  OR NEW.email <> OLD.email
  OR NEW.role <> OLD.role
  OR COALESCE(NEW.account_status, '') <> COALESCE(OLD.account_status, '')
BEGIN
  UPDATE users
  SET security_stamp = lower(hex(randomblob(16)))
  WHERE id = NEW.id;
END;
