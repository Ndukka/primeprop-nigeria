import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(currentDirectory, '..');
const repositoryDirectory = resolve(workerDirectory, '..');

function source(relativePath: string): string {
  return readFileSync(resolve(repositoryDirectory, relativePath), 'utf8');
}

describe('feedback CSRF recovery and frontend contracts', () => {
  it('uses an authenticated session-bound synchronizer token', () => {
    const csrf = source('worker/src/feedback-csrf.ts');
    const routes = source('worker/src/feedback-route-helpers.ts');
    const auth = source('worker/src/feedback-auth-routes.ts');

    expect(csrf).toContain('reviewerRequestProof');
    expect(csrf).toContain('validateSessionCsrf');
    expect(csrf).toContain('ensureSessionCsrf');
    expect(csrf).toContain('UPDATE reviewer_sessions');
    expect(csrf).toContain('csrf_hash = ?');
    expect(routes).toContain('reviewerRequestProof(c.req.raw)');
    expect(routes).toContain('validateSessionCsrf(c.req.raw, session)');
    expect(routes).not.toContain('authorization === `Feedback ${csrf}`');
    expect(auth).toContain('csrfToken: csrf.token');
    expect(auth).toContain('ensureSessionCsrf(c.req.raw, env, session)');
  });

  it('recovers one stale-token write without weakening origin checks', () => {
    const client = source('public/js/feedback-client.js');
    const policy = source('worker/src/feedback-policy.ts');

    expect(client).toContain("error?.message !== 'CSRF token mismatch.'");
    expect(client).toContain('const state = await session()');
    expect(client).toContain('return jsonResponse(await sendWrite(path, body, method))');
    expect(policy).toContain('isAllowedFeedbackOrigin');
    expect(policy).toContain("if (!isAllowedFeedbackOrigin(request.headers.get('Origin'), env))");
  });

  it('isolates reviewer writes from stale professional CSRF cookies only', () => {
    const production = source('worker/src/production-entry.ts');

    expect(production).toContain('const REVIEWER_WRITE_PATHS = new Set([');
    expect(production).toContain("'/auth/feedback/ratings'");
    expect(production).toContain("'/auth/feedback/reports'");
    expect(production).toContain("'/auth/feedback/logout'");
    expect(production).toContain("authorization.startsWith('Feedback ')");
    expect(production).toContain(".filter(part => !part.startsWith('pp_csrf='))");
    expect(production).toContain('request = isolateReviewerCsrfBoundary(request)');
    expect(production).not.toContain("'/auth/feedback/admin/");
  });

  it('preserves only allowlisted feedback actions through Google OAuth', () => {
    const returns = source('worker/src/feedback-return.ts');
    const client = source('public/js/feedback-client.js');

    expect(returns).toContain("'rate-agent'");
    expect(returns).toContain("'report-agent'");
    expect(returns).toContain("'report-listing'");
    expect(returns).toContain("new Set(['id', 'feedbackAction'])");
    expect(returns).toContain("new Set(['id', 'listing', 'feedbackAction'])");
    expect(returns).toContain("if (!SAFE_RETURN_PATHS.has(parsed.pathname)) return '/properties'");
    expect(client).toContain("url.searchParams.set('feedbackAction', action)");
    expect(client).toContain('resumeFeedbackAction(pendingIntent)');
    expect(client).toContain('control.click()');
  });

  it('renders centered structured dialogs and visible rating/comment surfaces', () => {
    const client = source('public/js/feedback-client.js');
    const listing = source('public/js/listing-feedback.js');
    const agent = source('public/js/agent-feedback.js');

    expect(client).toContain('inset: 0');
    expect(client).toContain('margin: auto');
    expect(client).toContain('.primeprop-feedback-shell');
    expect(client).toContain('#primepropFeedbackDialog::backdrop');
    expect(listing).toContain('Rate & review this agent');
    expect(listing).toContain('Ratings, reviews and safety');
    expect(listing).toContain("feedback.currentReturnPath('rate-agent')");
    expect(listing).toContain("feedback.currentReturnPath(action)");
    expect(agent).toContain('Ratings and reviews');
    expect(agent).toContain('Approved review comments');
    expect(agent).toContain('No approved written comments have been published yet.');
    expect(agent).toContain('Ratings are unavailable for this legacy listing profile');
  });

  it('records both reviewer CSRF incidents in the permanent error bank', () => {
    const errors = source('errors.md');
    expect(errors).toContain('PP-ERR-047');
    expect(errors).toContain('PP-ERR-048');
    expect(errors).toContain('CSRF token mismatch');
    expect(errors).toContain('automatic Google return');
    expect(errors).toContain('stale professional CSRF cookie');
  });
});
