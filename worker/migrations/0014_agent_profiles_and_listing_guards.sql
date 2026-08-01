-- Agent profile defaults and database-level listing role safeguards.
-- Forward-only: production migrations are never edited in place.

ALTER TABLE users ADD COLUMN agent_title TEXT NOT NULL DEFAULT 'Listing Agent';

UPDATE users
SET agent_title = 'Listing Agent'
WHERE role = 'agent'
  AND (agent_title IS NULL OR trim(agent_title) = '');

-- Existing agent-owned listings inherit the account profile immediately.
UPDATE listings
SET agent_name = COALESCE((SELECT name FROM users WHERE users.id = listings.created_by), agent_name, ''),
    agent_role = COALESCE(NULLIF((SELECT agent_title FROM users WHERE users.id = listings.created_by), ''), 'Listing Agent'),
    agent_phone = COALESCE((SELECT phone FROM users WHERE users.id = listings.created_by), ''),
    agent_avatar = COALESCE((SELECT avatar_url FROM users WHERE users.id = listings.created_by), ''),
    featured = 0,
    verified = 0,
    badge = ''
WHERE created_by IN (SELECT id FROM users WHERE role = 'agent');

-- New agent-owned listings always use account profile values and cannot create
-- their own trust/moderation state, regardless of the submitted browser body.
CREATE TRIGGER IF NOT EXISTS trg_agent_listing_profile_after_insert
AFTER INSERT ON listings
WHEN NEW.created_by IN (SELECT id FROM users WHERE role = 'agent')
BEGIN
  UPDATE listings
  SET agent_name = COALESCE((SELECT name FROM users WHERE id = NEW.created_by), ''),
      agent_role = COALESCE(NULLIF((SELECT agent_title FROM users WHERE id = NEW.created_by), ''), 'Listing Agent'),
      agent_phone = COALESCE((SELECT phone FROM users WHERE id = NEW.created_by), ''),
      agent_avatar = COALESCE((SELECT avatar_url FROM users WHERE id = NEW.created_by), ''),
      featured = 0,
      verified = 0,
      badge = ''
  WHERE id = NEW.id;
END;

-- Reject any noncanonical trust or identity values on an agent-owned listing.
-- Canonical normalization and profile propagation remain permitted.
CREATE TRIGGER IF NOT EXISTS trg_guard_agent_listing_managed_fields
BEFORE UPDATE OF featured, verified, badge, agent_name, agent_role, agent_phone, agent_avatar ON listings
WHEN OLD.created_by IN (SELECT id FROM users WHERE role = 'agent')
  AND (
    COALESCE(NEW.featured, 0) <> 0
    OR COALESCE(NEW.verified, 0) <> 0
    OR COALESCE(NEW.badge, '') <> ''
    OR COALESCE(NEW.agent_name, '') <> COALESCE((SELECT name FROM users WHERE id = OLD.created_by), '')
    OR COALESCE(NEW.agent_role, '') <> COALESCE(NULLIF((SELECT agent_title FROM users WHERE id = OLD.created_by), ''), 'Listing Agent')
    OR COALESCE(NEW.agent_phone, '') <> COALESCE((SELECT phone FROM users WHERE id = OLD.created_by), '')
    OR COALESCE(NEW.agent_avatar, '') <> COALESCE((SELECT avatar_url FROM users WHERE id = OLD.created_by), '')
  )
BEGIN
  SELECT RAISE(ABORT, 'agent listing trust and identity fields are centrally managed');
END;

-- A profile edit updates all existing listings owned by that agent so contact
-- details are entered once, not repeated for every listing.
CREATE TRIGGER IF NOT EXISTS trg_agent_profile_propagates_to_listings
AFTER UPDATE OF name, phone, avatar_url, agent_title ON users
WHEN NEW.role = 'agent'
BEGIN
  UPDATE listings
  SET agent_name = COALESCE(NEW.name, ''),
      agent_role = COALESCE(NULLIF(NEW.agent_title, ''), 'Listing Agent'),
      agent_phone = COALESCE(NEW.phone, ''),
      agent_avatar = COALESCE(NEW.avatar_url, '')
  WHERE created_by = NEW.id;
END;
