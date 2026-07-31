-- PrimeProp Nigeria — Initial Schema
-- Run: wrangler d1 migrations apply primeprop-db

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,              -- NULL for OAuth users
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'lister',  -- 'admin' | 'lister'
  avatar_url TEXT,
  phone TEXT,
  google_id TEXT UNIQUE,           -- Google OAuth ID
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,              -- 'rent' | 'sale' | 'land'
  property_type TEXT,              -- 'apartment' | 'duplex' | etc.
  price INTEGER NOT NULL,
  price_unit TEXT DEFAULT '',
  location TEXT NOT NULL,
  area TEXT,
  city TEXT,
  bedrooms INTEGER DEFAULT 0,
  bathrooms INTEGER DEFAULT 0,
  sqft INTEGER DEFAULT 0,
  parking INTEGER DEFAULT 0,
  description TEXT,
  amenities TEXT DEFAULT '[]',     -- JSON array
  images TEXT DEFAULT '[]',        -- JSON array of URLs
  availability TEXT DEFAULT 'Immediately',
  featured INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  badge TEXT DEFAULT '',
  agent_name TEXT,
  agent_role TEXT,
  agent_phone TEXT,
  agent_avatar TEXT,
  annual_rent INTEGER,
  agency_fee INTEGER,
  security_deposit INTEGER,
  service_charge INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS districts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  description TEXT,
  checks TEXT DEFAULT '[]',        -- JSON array
  image TEXT,
  link_type TEXT DEFAULT 'all',    -- 'all' | 'sale' | 'rent' | 'land'
  created_at TEXT DEFAULT (datetime('now'))
);

-- Seed admin user (password: admin123 — CHANGE AFTER FIRST LOGIN)
-- bcrypt hash of 'admin123'
INSERT OR IGNORE INTO users (email, password_hash, name, role) 
VALUES ('admin@primeprop.ng', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'Admin', 'admin');

-- Seed demo districts
INSERT OR IGNORE INTO districts (name, city, description, checks, image, link_type) VALUES
('Ikeja GRA', 'Lagos', 'A central Lagos residential district where inspection planning should include road access, power, water, estate charges, and commute timing.', '["Road access","Power and water","Total move-in cost"]', 'https://images.unsplash.com/photo-1460317442991-0ec209397118?auto=format&fit=crop&w=800&q=80', 'sale'),
('Wuse 2', 'Abuja', 'A mixed residential and commercial district where buyers should compare access, service arrangements, documentation, and building condition.', '["Building condition","Document review","Service arrangements"]', 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=800&q=80', 'all'),
('Lekki Phase 1', 'Lagos', 'A high-demand Lagos district where estate charges, drainage, traffic, power, water, and precise inspection timing materially affect a decision.', '["Estate charges","Drainage and access","Inspection timing"]', 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?auto=format&fit=crop&w=800&q=80', 'all'),
('Victoria Island', 'Lagos', 'Premium Lagos commercial and residential hub. Inspection should verify flood risk, power supply stability, security arrangements, and service charge structures.', '["Flood risk & drainage","Service charges","Security arrangements"]', 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=800&q=80', 'all'),
('Maitama', 'Abuja', 'High-end Abuja district with diplomatic and government presence. Verify title documentation, building approvals, and service arrangements carefully.', '["Title verification","Building approvals","Utility reliability"]', 'https://images.unsplash.com/photo-1444723121867-7a241cacace9?auto=format&fit=crop&w=800&q=80', 'all'),
('Asokoro', 'Abuja', 'Secure, well-planned Abuja district popular with professionals and families. Check estate rules, access control, and proximity to amenities.', '["Gated estate rules","Proximity to amenities","Access control"]', 'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?auto=format&fit=crop&w=800&q=80', 'all');
