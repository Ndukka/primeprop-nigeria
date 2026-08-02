-- Migration: 0020_security_stamp_invalidation_timestamp.sql
-- Keep access-token invalidation synchronized with every security-stamp change.
--
-- The hardened authentication boundary compares a token's issued-at time with
-- users.security_stamp_changed_at. Several established revocation paths rotate
-- security_stamp, so the database must advance the matching timestamp in the
-- same logical operation. Centralizing this invariant in D1 prevents any one
-- caller from revoking refresh rows while accidentally leaving an issued access
-- token usable.

CREATE TRIGGER IF NOT EXISTS trg_security_stamp_invalidation_timestamp
AFTER UPDATE OF security_stamp ON users
WHEN NEW.security_stamp IS NOT OLD.security_stamp
BEGIN
  UPDATE users
  SET security_stamp_changed_at =
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)
  WHERE id = NEW.id;
END;
