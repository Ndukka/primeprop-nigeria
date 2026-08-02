import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKER_DIR = resolve(__dirname, '..');
const REPOSITORY_DIR = resolve(WORKER_DIR, '..');
const DIST_DIR = resolve(REPOSITORY_DIR, 'dist-public');

function source(relativePath: string): string {
  return readFileSync(resolve(WORKER_DIR, relativePath), 'utf8');
}

function generatedSource(sourcePath: string): string {
  const manifest = JSON.parse(
    readFileSync(resolve(DIST_DIR, 'asset-manifest.json'), 'utf8'),
  ) as { assets: Record<string, string> };
  const generated = manifest.assets[sourcePath];
  expect(generated, `${sourcePath} must be emitted`).toBeTruthy();
  return readFileSync(resolve(DIST_DIR, generated.replace(/^\//, '')), 'utf8');
}

function generatedAssetUrl(sourcePath: string): string {
  const manifest = JSON.parse(
    readFileSync(resolve(DIST_DIR, 'asset-manifest.json'), 'utf8'),
  ) as { assets: Record<string, string> };
  const generated = manifest.assets[sourcePath];
  expect(generated, `${sourcePath} must be emitted`).toBeTruthy();
  return generated;
}

function generatedPage(relativePath: string): string {
  return readFileSync(resolve(DIST_DIR, relativePath), 'utf8');
}

describe('agent listing approval source safeguards', () => {
  it('routes every legacy listing read and write through approval-aware handlers', () => {
    const productionEntry = source('src/production-entry.ts');

    expect(productionEntry).toContain('function routeListingApprovalBoundary(request: Request)');
    expect(productionEntry).toContain("url.pathname = '/auth/public-listing-stats'");
    expect(productionEntry).toContain("url.pathname = '/auth/public-listings'");
    expect(productionEntry).toContain('`/auth/public-listings/${listingMatch[1]}`');
    expect(productionEntry).toContain("url.pathname = '/auth/listing-records'");
    expect(productionEntry).toContain('`/auth/listing-records/${listingMatch[1]}`');
    expect(productionEntry).toContain('request = routeListingApprovalBoundary(request)');
  });

  it('applies approved-and-active-owner visibility to every public listing surface', () => {
    const approvalRoutes = source('src/listing-approval-routes.ts');
    const contactRoutes = source('src/admin-inventory-routes.ts');

    expect(approvalRoutes).toContain("const clauses = [\"l.approval_status = 'approved'\", ACTIVE_OWNER_PREDICATE]");
    expect(approvalRoutes).toContain("AND l.approval_status = 'approved'");
    expect(approvalRoutes).toContain("const visible = `l.approval_status = 'approved' AND ${ACTIVE_OWNER_PREDICATE}`");
    expect(approvalRoutes).toContain("COALESCE(owner.account_status, 'active') = 'active'");
    expect(contactRoutes).toContain("AND l.approval_status = 'approved'");
    expect(contactRoutes).toContain("COALESCE(owner.account_status, 'active') = 'active'");
  });

  it('requires an administrator and an active owner for publication', () => {
    const approvalRoutes = source('src/listing-approval-routes.ts');

    expect(approvalRoutes).toContain("'/admin-listings/:id/approval'");
    expect(approvalRoutes).toContain("requireRole('admin')");
    expect(approvalRoutes).toContain("existing.owner_account_status !== 'active'");
    expect(approvalRoutes).toContain('approved_by = ?');
    expect(approvalRoutes).toContain("approved_at = datetime('now')");
  });

  it('enforces pending inserts, guarded approval, reapproval, and suspension in D1', () => {
    const approvalMigration = source('migrations/0015_listing_approval.sql');
    const suspensionMigration = source('migrations/0016_user_visibility_and_moderation_guards.sql');

    expect(approvalMigration).toContain("CHECK (approval_status IN ('pending', 'approved'))");
    expect(approvalMigration).toContain('trg_agent_listing_approval_after_insert');
    expect(approvalMigration).toContain("SET approval_status = 'pending'");
    expect(approvalMigration).toContain('trg_guard_listing_approval_update');
    expect(approvalMigration).toContain("role = 'admin'");
    expect(approvalMigration).toContain('trg_agent_listing_change_requires_reapproval');
    expect(approvalMigration).toContain('agent_name, agent_role, agent_phone, agent_avatar');

    expect(suspensionMigration).toContain('trg_inactive_user_revokes_sessions');
    expect(suspensionMigration).toContain('UPDATE sessions');
    expect(suspensionMigration).toContain('trg_preserve_last_active_administrator');
    expect(suspensionMigration).toContain('trg_inactive_listing_owner_cannot_be_approved');
    expect(suspensionMigration).toContain("account_status = 'active'");
  });

  it('shows a dedicated approvals tab and reversible user-pausing controls', () => {
    const admin = generatedSource('js/admin-compat.js');
    const agent = generatedSource('js/agent-data.js');

    expect(admin).toContain("approvalsTab.id = 'tabApprovals'");
    expect(admin).toContain("wrap.id = 'approvalsTableWrap'");
    expect(admin).toContain("listing.approvalStatus !== 'approved'");
    expect(admin).toContain("'Banned · paused'");
    expect(admin).toContain('every listing they own will be hidden until unbanned');
    expect(admin).toContain('/auth/admin-listings/${encodeURIComponent(id)}/approval');
    expect(admin).toContain("approved ? 'pending' : 'approved'");
    expect(agent).toContain("'✓ Approved · Live'");
    expect(agent).toContain("'⏳ Pending admin approval'");
    expect(agent).toContain('Listing submitted for administrator approval.');
    expect(agent).toContain('Listing updated and returned for administrator approval.');
  });

  it('hides tracked media owned by inactive users without breaking legacy objects', () => {
    const productionEntry = source('src/production-entry.ts');

    expect(productionEntry).toContain('async function trackedMediaAccess(request: Request, env: Bindings)');
    expect(productionEntry).toContain('FROM upload_objects uo');
    expect(productionEntry).toContain("COALESCE(u.account_status, 'missing') AS account_status");
    expect(productionEntry).toContain("if (!owner) return { tracked: false, response: null }");
    expect(productionEntry).toContain("if (owner.account_status === 'active')");
    expect(productionEntry).toContain('if (await isActiveAdministrator(request, env))');
    expect(productionEntry).toContain("headers.set('Cache-Control', 'private, max-age=0, must-revalidate')");
    expect(productionEntry).toContain("return jsonResponse({ success: false, message: 'Not found' }, 404)");
    expect(productionEntry).toContain('const mediaAccess = await trackedMediaAccess(request, env)');
    expect(productionEntry).toContain('if (mediaAccess.tracked) response = withTrackedMediaCachePolicy(response)');
  });

  it('keeps rich profile data in one editable user record with administrator-controlled verification', () => {
    const migration = source('migrations/0017_agent_public_profiles.sql');
    const routes = source('src/role-profile-routes.ts');
    const listingDto = source('src/utils.ts');

    expect(migration).toContain('ALTER TABLE users ADD COLUMN bio');
    expect(migration).toContain('ALTER TABLE users ADD COLUMN organization_name');
    expect(migration).toContain('ALTER TABLE users ADD COLUMN service_areas');
    expect(migration).toContain('ALTER TABLE users ADD COLUMN profile_verified');
    expect(migration).toContain('ALTER TABLE users ADD COLUMN profile_published');
    expect(routes).toContain("authRoutes.get('/public-agents/:id'");
    expect(routes).toContain("AND account_status = 'active'");
    expect(routes).toContain('AND profile_published = 1');
    expect(routes).toContain("approval_status = 'approved'");
    expect(routes).toContain("'/admin-profile-settings/:id'");
    expect(routes).toContain('editableProfileUpdates(body, includeVerification)');
    expect(routes).toContain('if (includeVerification && body.profile_verified !== undefined)');
    expect(listingDto).toContain('id: ownerId > 0 ? ownerId : null');
  });

  it('builds the themed agent page and injects profile editors and listing navigation', () => {
    const page = generatedPage('agent-profile.html');
    const listingPage = generatedPage('listing-detail.html');
    const agentPage = generatedPage('agent.html');
    const adminPage = generatedPage('admin.html');
    const profileCssUrl = generatedAssetUrl('agent-profile.css');
    const profileClientUrl = generatedAssetUrl('js/agent-profile.js');
    const listingLinkUrl = generatedAssetUrl('js/listing-agent-profile-link.js');
    const agentEditorUrl = generatedAssetUrl('js/agent-profile-editor.js');
    const adminEditorUrl = generatedAssetUrl('js/admin-agent-profile-editor.js');
    const profileClient = generatedSource('js/agent-profile.js');
    const listingLink = generatedSource('js/listing-agent-profile-link.js');
    const agentEditor = generatedSource('js/agent-profile-editor.js');
    const adminEditor = generatedSource('js/admin-agent-profile-editor.js');

    expect(page).toContain('id="agentProfileContent"');
    expect(page).toContain(profileCssUrl);
    expect(page).toContain(profileClientUrl);
    expect(listingPage).toContain(listingLinkUrl);
    expect(agentPage).toContain(agentEditorUrl);
    expect(adminPage).toContain(adminEditorUrl);
    expect(profileClient).toContain('/auth/public-agents/${encodeURIComponent(id)}');
    expect(profileClient).toContain('Active listings');
    expect(listingLink).toContain("#detailContent .detail-sidebar .detail-contact-card");
    expect(listingLink).toContain('/agent-profile?id=${encodeURIComponent(agentId)}');
    expect(agentEditor).toContain("'/auth/profile-settings'");
    expect(adminEditor).toContain('/auth/admin-profile-settings/${encodeURIComponent(id)}');
  });
});
