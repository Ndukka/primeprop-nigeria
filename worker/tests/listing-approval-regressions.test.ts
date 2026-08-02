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

  it('applies one approved-only predicate to list, detail, stats, and contact routes', () => {
    const approvalRoutes = source('src/listing-approval-routes.ts');
    const contactRoutes = source('src/admin-inventory-routes.ts');

    expect(approvalRoutes).toContain("const clauses = [\"approval_status = 'approved'\"]");
    expect(approvalRoutes).toContain("id = ? AND approval_status = 'approved'");
    expect(approvalRoutes).toContain("const approved = \"approval_status = 'approved'\"");
    expect(contactRoutes).toContain("AND l.approval_status = 'approved'");
  });

  it('requires an administrator for the only approval transition endpoint', () => {
    const approvalRoutes = source('src/listing-approval-routes.ts');

    expect(approvalRoutes).toContain("'/admin-listings/:id/approval'");
    expect(approvalRoutes).toContain("requireRole('admin')");
    expect(approvalRoutes).toContain("approval_status = 'approved'");
    expect(approvalRoutes).toContain('approved_by = ?');
    expect(approvalRoutes).toContain("approved_at = datetime('now')");
  });

  it('enforces pending inserts, guarded approval, and reapproval in D1', () => {
    const migration = source('migrations/0015_listing_approval.sql');

    expect(migration).toContain("CHECK (approval_status IN ('pending', 'approved'))");
    expect(migration).toContain('trg_agent_listing_approval_after_insert');
    expect(migration).toContain("SET approval_status = 'pending'");
    expect(migration).toContain('trg_guard_listing_approval_update');
    expect(migration).toContain("role = 'admin'");
    expect(migration).toContain('trg_agent_listing_change_requires_reapproval');
    expect(migration).toContain('agent_name, agent_role, agent_phone, agent_avatar');
  });

  it('shows approval controls to administrators and status to agents', () => {
    const admin = generatedSource('js/admin-compat.js');
    const agent = generatedSource('js/agent-data.js');

    expect(admin).toContain('/auth/admin-listings/${encodeURIComponent(id)}/approval');
    expect(admin).toContain("'Approved · Live'");
    expect(admin).toContain("'Pending approval'");
    expect(admin).toContain("approved ? 'pending' : 'approved'");
    expect(agent).toContain("'✓ Approved · Live'");
    expect(agent).toContain("'⏳ Pending admin approval'");
    expect(agent).toContain('Listing submitted for administrator approval.');
    expect(agent).toContain('Listing updated and returned for administrator approval.');
  });
});
