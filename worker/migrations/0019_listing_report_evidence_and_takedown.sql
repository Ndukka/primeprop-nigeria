-- Migration: 0019_listing_report_evidence_and_takedown.sql
-- Adds report-linked moderation evidence and reversible listing takedown state.
-- Exact network evidence is retained only while a case is open and for a
-- limited period after closure; a keyed fingerprint remains for abuse pattern
-- correlation without retaining the original address indefinitely.

ALTER TABLE moderation_reports ADD COLUMN reporter_email_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE moderation_reports ADD COLUMN reporter_email_verified INTEGER NOT NULL DEFAULT 1
  CHECK (reporter_email_verified IN (0, 1));
ALTER TABLE moderation_reports ADD COLUMN reporter_ip TEXT;
ALTER TABLE moderation_reports ADD COLUMN reporter_ip_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE moderation_reports ADD COLUMN reporter_country TEXT;
ALTER TABLE moderation_reports ADD COLUMN reporter_user_agent TEXT;
ALTER TABLE moderation_reports ADD COLUMN request_id TEXT;
ALTER TABLE moderation_reports ADD COLUMN evidence_expires_at TEXT;
ALTER TABLE moderation_reports ADD COLUMN listing_action TEXT NOT NULL DEFAULT 'none'
  CHECK (listing_action IN ('none', 'taken_down'));
ALTER TABLE moderation_reports ADD COLUMN listing_actioned_at TEXT;
ALTER TABLE moderation_reports ADD COLUMN listing_actioned_by INTEGER REFERENCES users(id);

UPDATE moderation_reports
SET reporter_email_snapshot = COALESCE((
  SELECT reviewer.email_normalized
  FROM reviewer_identities reviewer
  WHERE reviewer.id = moderation_reports.reporter_reviewer_id
), '')
WHERE reporter_email_snapshot = '';

CREATE INDEX IF NOT EXISTS idx_moderation_reports_ip_hash
  ON moderation_reports(reporter_ip_hash, submitted_at);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_evidence_expiry
  ON moderation_reports(evidence_expires_at);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_listing_action
  ON moderation_reports(listing_id, listing_action, listing_actioned_at);
