-- Migration: 0011_indexes.sql
-- PP-SEC-027: Performance indexes for common query patterns.
-- Adds covering and composite indexes to speed up listing searches,
-- session cleanup, password reset expiry, and audit-log queries.

-- Listings: filter/sort by creator
CREATE INDEX IF NOT EXISTS idx_listings_created_by ON listings(created_by);

-- Listings: browse by type within city
CREATE INDEX IF NOT EXISTS idx_listings_type_city ON listings(type, city);

-- Listings: featured listings sorted newest-first
CREATE INDEX IF NOT EXISTS idx_listings_featured_id ON listings(featured, id DESC);

-- Listings: filter verified properties
CREATE INDEX IF NOT EXISTS idx_listings_verified ON listings(verified);

-- Listings: price range within city
CREATE INDEX IF NOT EXISTS idx_listings_city_price ON listings(city, price);

-- Listings: filter by bedroom count
CREATE INDEX IF NOT EXISTS idx_listings_bedrooms ON listings(bedrooms);

-- Listings: type + price for category-range scans
CREATE INDEX IF NOT EXISTS idx_listings_type_price ON listings(type, price);

-- Sessions: efficient expired/active cleanup
CREATE INDEX IF NOT EXISTS idx_sessions_expires_revoked ON sessions(expires_at, revoked);

-- Password resets: bulk expire stale tokens
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets(expires_at);

-- Audit events: time-range queries
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);

-- Belt-and-braces: rate_limits was dropped in 0007 but ensure it's gone
DROP TABLE IF EXISTS rate_limits;
