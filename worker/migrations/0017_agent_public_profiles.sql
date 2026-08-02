-- Rich public agent profiles and organisation details.
-- Forward-only: existing production migrations are never edited in place.

ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN organization_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN organization_role TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN organization_website TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN organization_address TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN organization_logo_url TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN public_email TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN website_url TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN service_areas TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN specialties TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN languages TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN professional_memberships TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN years_experience INTEGER NOT NULL DEFAULT 0 CHECK (years_experience BETWEEN 0 AND 80);
ALTER TABLE users ADD COLUMN license_body TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN license_number TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN response_time TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN office_hours TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN linkedin_url TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN instagram_url TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN profile_verified INTEGER NOT NULL DEFAULT 0 CHECK (profile_verified IN (0, 1));
ALTER TABLE users ADD COLUMN profile_published INTEGER NOT NULL DEFAULT 1 CHECK (profile_published IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_users_public_agent_profile
ON users(role, account_status, profile_published);
