-- Password reset tokens
-- PP-SEC-005: The token column stores SHA-256 hashes of the reset tokens, never plaintext.
-- The plaintext token is generated server-side, hashed, and only the hash is persisted.
-- Lookups are done by hashing the user-supplied token and comparing against this column.
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
-- PP-SEC-005: Composite index for bulk invalidation of old tokens when a new reset is requested
CREATE INDEX IF NOT EXISTS idx_password_resets_user_expires ON password_resets(user_id, expires_at);
