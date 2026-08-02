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
});
