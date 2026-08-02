import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(currentDirectory, '..');
const repositoryDirectory = resolve(workerDirectory, '..');
const distPublic = resolve(repositoryDirectory, 'dist-public');

function source(relativePath: string): string {
  return readFileSync(resolve(repositoryDirectory, relativePath), 'utf8');
}

function built(relativePath: string): string {
  return readFileSync(resolve(distPublic, relativePath.replace(/^\//, '')), 'utf8');
}

type Manifest = {
  assets: Record<string, string>;
  pages: Array<{ relativePath: string }>;
};

function manifest(): Manifest {
  return JSON.parse(built('asset-manifest.json')) as Manifest;
}

function generatedAsset(sourcePath: string): string {
  const generated = manifest().assets[sourcePath];
  expect(generated, `${sourcePath} must be emitted`).toBeTruthy();
  return built(generated);
}

describe('feedback architecture and privacy contracts', () => {
  it('keeps public reviewers separate from professional users', () => {
    const migration = source('worker/migrations/0018_feedback_and_reviewer_identities.sql');
    const auth = source('worker/src/feedback-auth-routes.ts');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS reviewer_identities');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS reviewer_sessions');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS reviewer_bans');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS agent_ratings');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS moderation_reports');
    expect(migration).not.toMatch(/ALTER TABLE users[^;]+reviewer/i);
    expect(auth).toContain("'/feedback/google'");
    expect(auth).toContain("'/feedback/google/callback'");
    expect(auth).toContain('GOOGLE_FEEDBACK_REDIRECT_URI');
    expect(auth).not.toContain("'agent'");
  });

  it('enforces rating identity, agent and listing rules at the database boundary', () => {
    const migration = source('worker/migrations/0018_feedback_and_reviewer_identities.sql');

    expect(migration).toContain('UNIQUE (reviewer_id, agent_user_id)');
    expect(migration).toContain('reviewer conflicts with professional account');
    expect(migration).toContain('agent is not publicly rateable');
    expect(migration).toContain('source listing is not eligible');
    expect(migration).toContain("listing.approval_status = 'approved'");
    expect(migration).toContain('listing.created_by = NEW.agent_user_id');
  });

  it('uses state, nonce, exact callback validation and PKCE S256 without storing Google tokens', () => {
    const auth = source('worker/src/feedback-auth-routes.ts');
    const policy = source('worker/src/feedback-policy.ts');

    expect(auth).toContain("url.pathname !== '/auth/feedback/google/callback'");
    expect(auth).toContain("url.searchParams.set('state', state)");
    expect(auth).toContain("url.searchParams.set('nonce', nonce)");
    expect(auth).toContain("url.searchParams.set('code_challenge_method', 'S256')");
    expect(auth).toContain('code_verifier: verifier');
    expect(auth).toContain('payload.email_verified !== true');
    expect(auth).toContain('professionalConflict');
    expect(policy).toContain("export const FEEDBACK_SESSION_COOKIE = '__Host-pp_feedback_session'");
    expect(policy).not.toContain('google_access_token');
    expect(policy).not.toContain('google_refresh_token');
  });

  it('masks reviewer email before constructing the public response DTO', () => {
    const publicRoutes = source('worker/src/feedback-public-routes.ts');
    const policy = source('worker/src/feedback-policy.ts');

    expect(publicRoutes).toContain('reviewerLabel: maskReviewerEmail');
    expect(publicRoutes).not.toContain('google_sub:');
    expect(publicRoutes).not.toContain('email_hash:');
    expect(publicRoutes).not.toContain('reviewerId:');
    expect(policy).toContain('export function maskReviewerEmail');
  });

  it('requires origin, session-bound CSRF and feedback authorization proof on reviewer writes', () => {
    const helpers = source('worker/src/feedback-route-helpers.ts');
    const client = source('public/js/feedback-client.js');

    expect(helpers).toContain('feedbackWriteRequestError');
    expect(helpers).toContain('validateReviewerCsrf');
    expect(helpers).toContain('Authorization');
    expect(helpers).toContain('Feedback ${csrf}');
    expect(helpers).toContain('pp_(?:session|refresh)');
    expect(client).toContain("'X-CSRF-Token': csrf");
    expect(client).toContain('Authorization: `Feedback ${csrf}`');
  });

  it('emits feedback assets and loads them only on relevant routes', () => {
    const clientRuntime = generatedAsset('js/client-data.js');
    const emitted = manifest().assets;

    for (const asset of [
      'js/feedback-client.js',
      'js/listing-feedback.js',
      'js/agent-feedback.js',
      'js/admin-feedback.js',
    ]) {
      expect(emitted[asset], `${asset} must be in the manifest`).toBeTruthy();
      expect(generatedAsset(asset).length).toBeGreaterThan(200);
    }

    expect(clientRuntime).toContain("/^\\/listing-detail(?:-[123])?$/");
    expect(clientRuntime).toContain("path === '/agent-profile'");
    expect(clientRuntime).toContain("path === '/admin'");
    expect(clientRuntime).toContain("loadRuntime('/js/feedback-client.js')");
    expect(clientRuntime).toContain("if (runtimeNonce) script.nonce = runtimeNonce");
    expect(clientRuntime).not.toContain("path === '/properties'");
  });

  it('provides listing, profile and administrator controls without unsafe HTML rendering', () => {
    const listing = source('public/js/listing-feedback.js');
    const profile = source('public/js/agent-feedback.js');
    const admin = source('public/js/admin-feedback.js');

    expect(listing).toContain('Rate this agent');
    expect(listing).toContain('Report this listing');
    expect(listing).toContain('Report this agent');
    expect(profile).toContain('Agent ratings');
    expect(profile).toContain('reviewerLabel');
    expect(admin).toContain('Approve score');
    expect(admin).toContain('Approve comment');
    expect(admin).toContain('Ban email');
    expect(admin).toContain('Unban');
    for (const script of [listing, profile, admin]) {
      expect(script).not.toContain('innerHTML =');
      expect(script).not.toContain('insertAdjacentHTML');
    }
  });
});
