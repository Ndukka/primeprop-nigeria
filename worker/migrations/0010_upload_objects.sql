-- Migration: 0010_upload_objects.sql
-- PP-SEC-030: Ownership tracking for R2 uploads.
-- Maps every R2 object to a user and optional listing so objects
-- can be audited, cleaned up, and attributed without scanning R2.

CREATE TABLE IF NOT EXISTS upload_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  listing_id INTEGER,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  folder TEXT DEFAULT 'images',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_upload_objects_user ON upload_objects(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_objects_listing ON upload_objects(listing_id);
CREATE INDEX IF NOT EXISTS idx_upload_objects_key ON upload_objects(object_key);
