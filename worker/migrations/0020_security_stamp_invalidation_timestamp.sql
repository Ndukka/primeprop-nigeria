-- Migration: 0020_security_stamp_invalidation_timestamp.sql
-- Replace the original second-resolution security-stamp trigger with a
-- millisecond-resolution version.
--
-- Access JWT `iat` values have second precision. When a stamp changed during
-- the same second as token issuance, the original `unixepoch() * 1000` value
-- could equal the token's issued-at value and fail the strict `<` invalidation
-- comparison. Dropping and recreating the established trigger avoids stacking
-- two competing triggers and makes same-second invalidation deterministic.

DROP TRIGGER IF EXISTS trg_security_stamp_timestamp;

CREATE TRIGGER trg_security_stamp_timestamp
AFTER UPDATE OF security_stamp ON users
WHEN NEW.security_stamp IS NOT OLD.security_stamp
BEGIN
  UPDATE users
  SET security_stamp_changed_at =
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER),
      updated_at = datetime('now')
  WHERE id = NEW.id;
END;
