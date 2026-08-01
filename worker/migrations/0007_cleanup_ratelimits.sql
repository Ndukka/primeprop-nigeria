-- Drop rate_limits table (replaced with in-memory rate limiting)
-- This was causing D1 exhaustion from excessive writes
DROP TABLE IF EXISTS rate_limits;
