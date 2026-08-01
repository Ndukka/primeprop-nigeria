-- Migration: 0012_account_safety.sql
-- Forward-only safeguards for issues that cannot be fixed by editing old,
-- already-applied migrations.

-- Ensure every existing user has a non-empty security stamp available for
-- immediate global-session invalidation checks.
UPDATE users
SET security_stamp = lower(hex(randomblob(16)))
WHERE security_stamp IS NULL OR security_stamp = '';

-- Public Google signups must follow the same approval policy as password
-- signups. The OAuth callback inserts google_id, so this trigger applies only
-- to newly-created Google identities and does not alter established accounts.
CREATE TRIGGER IF NOT EXISTS trg_google_signup_pending
AFTER INSERT ON users
WHEN NEW.google_id IS NOT NULL
  AND COALESCE(NEW.account_status, 'active') = 'active'
BEGIN
  UPDATE users
  SET account_status = 'pending',
      security_stamp = CASE
        WHEN NEW.security_stamp IS NULL OR NEW.security_stamp = ''
          THEN lower(hex(randomblob(16)))
        ELSE NEW.security_stamp
      END,
      updated_at = datetime('now')
  WHERE id = NEW.id;
END;

-- Database-level protection against removing the final active administrator.
-- This covers API bugs, scripts, and direct D1 writes.
CREATE TRIGGER IF NOT EXISTS trg_prevent_last_active_admin_update
BEFORE UPDATE OF role, account_status ON users
WHEN OLD.role = 'admin'
  AND COALESCE(OLD.account_status, 'active') = 'active'
  AND (
    NEW.role <> 'admin'
    OR COALESCE(NEW.account_status, 'active') <> 'active'
  )
  AND (
    SELECT COUNT(*)
    FROM users
    WHERE role = 'admin'
      AND COALESCE(account_status, 'active') = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot remove the last active administrator');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_last_active_admin_delete
BEFORE DELETE ON users
WHEN OLD.role = 'admin'
  AND COALESCE(OLD.account_status, 'active') = 'active'
  AND (
    SELECT COUNT(*)
    FROM users
    WHERE role = 'admin'
      AND COALESCE(account_status, 'active') = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot delete the last active administrator');
END;
