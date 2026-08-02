-- Agent listings require explicit administrator approval before publication.
-- Existing listings are grandfathered as approved to preserve the live catalogue.

ALTER TABLE listings
ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'
CHECK (approval_status IN ('pending', 'approved'));

ALTER TABLE listings
ADD COLUMN approved_by INTEGER REFERENCES users(id);

ALTER TABLE listings
ADD COLUMN approved_at TEXT;

CREATE INDEX IF NOT EXISTS idx_listings_approval_status
ON listings(approval_status, featured, id);

-- Every browser/API insert records an authenticated creator. If that creator is
-- an agent, approval is forced to pending after the row is created, regardless
-- of any crafted request body or which legacy write route was used.
CREATE TRIGGER IF NOT EXISTS trg_agent_listing_approval_after_insert
AFTER INSERT ON listings
WHEN NEW.created_by IN (SELECT id FROM users WHERE role = 'agent')
BEGIN
  UPDATE listings
  SET approval_status = 'pending',
      approved_by = NULL,
      approved_at = NULL
  WHERE id = NEW.id;
END;

-- Pending rows never carry approval metadata. A pending-to-approved transition
-- must identify an active administrator and record the approval time. Existing
-- grandfathered approved rows may retain NULL metadata until they are reviewed
-- or edited; a future transition from pending cannot use that legacy exception.
CREATE TRIGGER IF NOT EXISTS trg_guard_listing_approval_update
BEFORE UPDATE OF approval_status, approved_by, approved_at ON listings
WHEN
  (NEW.approval_status = 'pending'
    AND (NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL))
  OR
  (NEW.approval_status = 'approved'
    AND (
      (OLD.approval_status <> 'approved'
        AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL))
      OR (NEW.approved_by IS NULL AND NEW.approved_at IS NOT NULL)
      OR (NEW.approved_by IS NOT NULL
        AND (
          NEW.approved_at IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM users
            WHERE id = NEW.approved_by
              AND role = 'admin'
              AND COALESCE(account_status, 'active') = 'active'
          )
        ))
    ))
BEGIN
  SELECT RAISE(ABORT, 'listing approval requires an active administrator');
END;

-- Any factual or agent-profile change to an approved agent-owned listing sends
-- it back for review. Approval-only changes are deliberately excluded so the
-- administrator approval endpoint can publish the unchanged row.
CREATE TRIGGER IF NOT EXISTS trg_agent_listing_change_requires_reapproval
AFTER UPDATE OF
  title, type, property_type, price, price_unit, location, area, city,
  bedrooms, bathrooms, sqft, parking, description, amenities, images,
  availability, annual_rent, agency_fee, security_deposit, service_charge,
  agent_name, agent_role, agent_phone, agent_avatar
ON listings
WHEN NEW.created_by IN (SELECT id FROM users WHERE role = 'agent')
  AND NEW.approval_status = 'approved'
BEGIN
  UPDATE listings
  SET approval_status = 'pending',
      approved_by = NULL,
      approved_at = NULL
  WHERE id = NEW.id;
END;
