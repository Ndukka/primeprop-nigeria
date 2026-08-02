-- Reversible account suspension and moderation guards.
-- Forward-only: existing migrations are never edited in place.

-- A suspended account loses every refresh session immediately. Access-token
-- requests are already rejected because authentication checks account_status
-- against D1 on every request.
CREATE TRIGGER IF NOT EXISTS trg_inactive_user_revokes_sessions
AFTER UPDATE OF account_status ON users
WHEN OLD.account_status <> NEW.account_status
  AND NEW.account_status <> 'active'
BEGIN
  UPDATE sessions
  SET revoked = 1
  WHERE user_id = NEW.id;
END;

-- Never allow the final active administrator to be demoted or suspended,
-- regardless of which application route or direct SQL path initiated it.
CREATE TRIGGER IF NOT EXISTS trg_preserve_last_active_administrator
BEFORE UPDATE OF role, account_status ON users
WHEN OLD.role = 'admin'
  AND OLD.account_status = 'active'
  AND (NEW.role <> 'admin' OR NEW.account_status <> 'active')
  AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id <> OLD.id
      AND role = 'admin'
      AND account_status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'cannot suspend or demote the last active administrator');
END;

-- Approval is impossible while the listing owner is inactive. Public queries
-- also enforce the same predicate, so already-approved listings are paused
-- without destroying their approval history and resume only after unban.
CREATE TRIGGER IF NOT EXISTS trg_inactive_listing_owner_cannot_be_approved
BEFORE UPDATE OF approval_status, approved_by, approved_at ON listings
WHEN NEW.approval_status = 'approved'
  AND NEW.created_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = NEW.created_by
      AND account_status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'listing owner must be active before approval');
END;
