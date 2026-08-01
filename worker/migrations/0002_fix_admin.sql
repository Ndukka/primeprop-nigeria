-- RETIRED: Embedded administrator password update (PP-SEC-007).
--
-- This migration previously changed a committed administrator password hash.
-- It must remain in the ordered migration history because existing D1
-- databases may already record migration 0002 as applied. A harmless SQL
-- statement keeps fresh databases and migration test runners able to apply the
-- complete historical sequence without recreating the insecure credential.
SELECT 1;
