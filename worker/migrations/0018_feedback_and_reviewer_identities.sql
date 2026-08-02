-- Migration: 0018_feedback_and_reviewer_identities.sql
-- Isolated Google reviewer identities, agent ratings, moderation reports and bans.
-- Reviewer identities are intentionally separate from professional users so a
-- public reviewer session can never authorize an administrator or agent route.

CREATE TABLE IF NOT EXISTS reviewer_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,
  email_normalized TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 1 CHECK (email_verified IN (0, 1)),
  first_authenticated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_authenticated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviewer_identities_email_hash
  ON reviewer_identities(email_hash);
CREATE INDEX IF NOT EXISTS idx_reviewer_identities_email
  ON reviewer_identities(email_normalized);

CREATE TABLE IF NOT EXISTS reviewer_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reviewer_id INTEGER NOT NULL REFERENCES reviewer_identities(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviewer_sessions_active
  ON reviewer_sessions(token_hash, revoked, expires_at);
CREATE INDEX IF NOT EXISTS idx_reviewer_sessions_reviewer
  ON reviewer_sessions(reviewer_id, revoked, expires_at);

CREATE TABLE IF NOT EXISTS reviewer_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reviewer_id INTEGER REFERENCES reviewer_identities(id) ON DELETE SET NULL,
  google_sub TEXT,
  email_normalized TEXT,
  email_hash TEXT,
  reason TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  banned_by INTEGER NOT NULL REFERENCES users(id),
  banned_at TEXT NOT NULL DEFAULT (datetime('now')),
  unbanned_by INTEGER REFERENCES users(id),
  unbanned_at TEXT,
  CHECK (
    reviewer_id IS NOT NULL
    OR (google_sub IS NOT NULL AND google_sub <> '')
    OR (email_hash IS NOT NULL AND email_hash <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_reviewer_bans_reviewer
  ON reviewer_bans(reviewer_id, active);
CREATE INDEX IF NOT EXISTS idx_reviewer_bans_google_sub
  ON reviewer_bans(google_sub, active);
CREATE INDEX IF NOT EXISTS idx_reviewer_bans_email_hash
  ON reviewer_bans(email_hash, active);

CREATE TABLE IF NOT EXISTS agent_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  reviewer_id INTEGER NOT NULL REFERENCES reviewer_identities(id) ON DELETE RESTRICT,
  agent_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  rating_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (rating_status IN ('pending', 'approved', 'rejected', 'removed')),
  comment_status TEXT NOT NULL DEFAULT 'none'
    CHECK (comment_status IN ('none', 'pending', 'approved', 'hidden', 'removed')),
  revision_count INTEGER NOT NULL DEFAULT 0 CHECK (revision_count BETWEEN 0 AND 5),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  moderated_by INTEGER REFERENCES users(id),
  moderated_at TEXT,
  moderation_note TEXT NOT NULL DEFAULT '',
  removed_at TEXT,
  UNIQUE (reviewer_id, agent_user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_ratings_public
  ON agent_ratings(agent_user_id, rating_status, comment_status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_agent_ratings_reviewer
  ON agent_ratings(reviewer_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_ratings_listing
  ON agent_ratings(source_listing_id);

CREATE TABLE IF NOT EXISTS moderation_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  reporter_reviewer_id INTEGER NOT NULL REFERENCES reviewer_identities(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (target_type IN ('listing', 'agent')),
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  agent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'misleading_information',
    'suspected_fraud',
    'impersonation',
    'property_unavailable',
    'incorrect_price',
    'duplicate_listing',
    'harassment',
    'unauthorised_agent',
    'other'
  )),
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'investigating', 'resolved', 'dismissed')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled_by INTEGER REFERENCES users(id),
  handled_at TEXT,
  resolution_note TEXT NOT NULL DEFAULT '',
  CHECK (
    (target_type = 'listing' AND listing_id IS NOT NULL AND agent_user_id IS NULL)
    OR
    (target_type = 'agent' AND agent_user_id IS NOT NULL AND listing_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_moderation_reports_queue
  ON moderation_reports(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_reviewer
  ON moderation_reports(reporter_reviewer_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_listing
  ON moderation_reports(listing_id, reason_code, submitted_at);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_agent
  ON moderation_reports(agent_user_id, reason_code, submitted_at);

-- Database-level rating eligibility. Application checks provide friendly
-- errors, while these triggers prevent an invalid direct write or future route
-- regression from publishing professional-account or mismatched-listing votes.
CREATE TRIGGER IF NOT EXISTS trg_agent_rating_eligibility_insert
BEFORE INSERT ON agent_ratings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM reviewer_identities reviewer
    WHERE reviewer.id = NEW.reviewer_id
      AND NOT EXISTS (
        SELECT 1 FROM users professional
        WHERE professional.google_id = reviewer.google_sub
           OR lower(professional.email) = reviewer.email_normalized
      )
  ) THEN RAISE(ABORT, 'reviewer conflicts with professional account') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM users agent
    WHERE agent.id = NEW.agent_user_id
      AND agent.role = 'agent'
      AND COALESCE(agent.account_status, 'active') = 'active'
      AND COALESCE(agent.profile_published, 0) = 1
  ) THEN RAISE(ABORT, 'agent is not publicly rateable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM listings listing
    WHERE listing.id = NEW.source_listing_id
      AND listing.created_by = NEW.agent_user_id
      AND listing.approval_status = 'approved'
  ) THEN RAISE(ABORT, 'source listing is not eligible') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_agent_rating_eligibility_update
BEFORE UPDATE OF reviewer_id, agent_user_id, source_listing_id, score ON agent_ratings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM reviewer_identities reviewer
    WHERE reviewer.id = NEW.reviewer_id
      AND NOT EXISTS (
        SELECT 1 FROM users professional
        WHERE professional.google_id = reviewer.google_sub
           OR lower(professional.email) = reviewer.email_normalized
      )
  ) THEN RAISE(ABORT, 'reviewer conflicts with professional account') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM users agent
    WHERE agent.id = NEW.agent_user_id
      AND agent.role = 'agent'
      AND COALESCE(agent.account_status, 'active') = 'active'
      AND COALESCE(agent.profile_published, 0) = 1
  ) THEN RAISE(ABORT, 'agent is not publicly rateable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM listings listing
    WHERE listing.id = NEW.source_listing_id
      AND listing.created_by = NEW.agent_user_id
      AND listing.approval_status = 'approved'
  ) THEN RAISE(ABORT, 'source listing is not eligible') END;
END;
