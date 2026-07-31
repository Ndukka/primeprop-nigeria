-- OWASP Security: Rate limiting table + account_status + role rename
CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

-- Add account_status to users if not exists
ALTER TABLE users ADD COLUMN account_status TEXT DEFAULT 'active';

-- Insert new columns for existing users
UPDATE users SET account_status = 'active' WHERE account_status IS NULL;
