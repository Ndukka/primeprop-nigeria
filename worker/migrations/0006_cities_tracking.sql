-- Cities table + user tracking
CREATE TABLE IF NOT EXISTS cities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  state TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Seed default cities
INSERT OR IGNORE INTO cities (name, state) VALUES ('Lagos', 'Lagos State');
INSERT OR IGNORE INTO cities (name, state) VALUES ('Abuja', 'FCT');

-- User tracking fields
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN login_count INTEGER DEFAULT 0;
