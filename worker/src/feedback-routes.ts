// Register the feedback subsystem on the shared /auth router.
// Each module owns one concern so reviewer identity, public DTOs, writes and
// administrator moderation remain independently reviewable.
import './feedback-auth-routes';
import './feedback-public-routes';
import './feedback-write-routes';
import './feedback-admin-routes';
