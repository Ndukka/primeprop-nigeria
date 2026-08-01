-- Migration: 0009_upload_tracking.sql
-- PP-SEC-015: Daily upload tracking table for per-user upload quotas.
-- Tracks count of uploads per user per day for rate limiting.

CREATE TABLE IF NOT EXISTS upload_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_date TEXT NOT NULL,            -- ISO date string: 'YYYY-MM-DD'
  count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, upload_date)
);

CREATE INDEX IF NOT EXISTS idx_upload_logs_user_date ON upload_logs(user_id, upload_date);
