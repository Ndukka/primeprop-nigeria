# PP-ERR-049: Agent profile feedback used a second stale identity resolver

- **Status**: Resolved in source; deploy the merged correction through the fail-closed production release command.
- **First observed**: On `/agent-profile?listing=<listing-id>` after the rating and reporting frontend was introduced.
- **Symptoms**: The agent profile itself loaded correctly from a listing reference, but the page could omit **Report this agent**, rating controls, the approved rating summary, and approved review comments. The feedback section could incorrectly describe the same registered agent as a legacy listing profile.
- **Root cause**: `agent-profile.js` already resolved either `?id=<agent-id>` or `?listing=<listing-id>` and, for a listing route, followed the listing owner to the registered public agent profile. `agent-feedback.js` contained a second stale resolver that read only `?id`. On a listing-based profile URL it independently concluded that there was no agent ID, even though the authoritative profile renderer had already resolved one. The policy module also retained superseded copies of return-path validation and cookie-based reviewer CSRF validation after those responsibilities moved to `feedback-return.ts` and `feedback-csrf.ts`.
- **Repair**: `agent-profile.js` now publishes the single resolved profile after rendering. `agent-feedback.js` consumes only that published profile, uses its database-backed agent ID for report and rating submissions, loads approved ratings and comments from that identity, and no longer parses profile query parameters, refetches the public agent, or polls the DOM with a duplicate observer. The obsolete return-path functions, return-path allowlist, and old reviewer-CSRF validator were removed from `feedback-policy.ts`.
- **Prevention**: Static contracts require one profile-resolution owner, prove that `?listing` is resolved by `agent-profile.js`, forbid `URLSearchParams`, `/auth/public-agents/`, and `MutationObserver` in `agent-feedback.js`, require the report-agent control and approved-comment surface, and prohibit the removed policy functions. TypeScript, strict asset generation, source tests, Worker runtime tests, and Wrangler integration tests must all pass before merge.
- **Immediate diagnosis**:
  ```bash
  cd "$(git rev-parse --show-toplevel)/worker"
  npm run test:static -- --run tests/feedback-ux-csrf-regressions.test.ts
  ```
