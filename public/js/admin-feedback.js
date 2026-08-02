/* Administrator-only ratings, reports and reviewer moderation console. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  const ui = window.PrimePropFeedback;
  if (!client || !ui) return;

  let mounted = false;
  let activeSection = 'ratings';
  let panel;
  let feedbackTab;

  function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node?.firstChild) node.removeChild(node.firstChild);
  }

  function button(label, className = 'btn btn-outline btn-xs') {
    const node = element('button', label, className);
    node.type = 'button';
    return node;
  }

  function badge(value) {
    const node = element('span', String(value || '—'), 'badge');
    node.style.background = '#e2e8f0';
    node.style.color = '#334155';
    node.style.textTransform = 'none';
    return node;
  }

  function displayDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  async function request(path, options = {}) {
    return client.requestJson(path, {
      cache: 'no-store',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
  }

  function existingPageNodes() {
    return [
      document.getElementById('statsGrid'),
      document.getElementById('listingsToolbar'),
      document.getElementById('listingsTableWrap'),
      document.getElementById('districtsTableWrap'),
      document.getElementById('usersTableWrap'),
    ].filter(Boolean);
  }

  function showFeedbackPanel() {
    for (const node of existingPageNodes()) node.style.display = 'none';
    panel.style.display = '';
    const addButton = document.getElementById('addButton');
    if (addButton) addButton.style.display = 'none';
    document.querySelectorAll('.tab-btn').forEach(tab => {
      tab.classList.remove('tab-active');
      tab.classList.add('btn-outline');
    });
    feedbackTab.classList.add('tab-active');
    feedbackTab.classList.remove('btn-outline');
    loadActiveSection();
  }

  function restoreExistingPage() {
    panel.style.display = 'none';
    const stats = document.getElementById('statsGrid');
    if (stats) stats.style.display = '';
    const addButton = document.getElementById('addButton');
    if (addButton) addButton.style.display = '';
    feedbackTab.classList.remove('tab-active');
    feedbackTab.classList.add('btn-outline');
  }

  function installTabBridge() {
    const original = window.switchTab;
    if (typeof original === 'function' && !original.feedbackWrapped) {
      const wrapped = function(tab) {
        restoreExistingPage();
        return original(tab);
      };
      wrapped.feedbackWrapped = true;
      window.switchTab = wrapped;
    }
  }

  function sectionButton(label, key) {
    const node = button(label, 'btn btn-sm btn-outline');
    node.dataset.feedbackSection = key;
    node.addEventListener('click', () => {
      activeSection = key;
      document.querySelectorAll('[data-feedback-section]').forEach(candidate => {
        candidate.classList.toggle('tab-active', candidate.dataset.feedbackSection === key);
        candidate.classList.toggle('btn-outline', candidate.dataset.feedbackSection !== key);
      });
      loadActiveSection();
    });
    return node;
  }

  function renderLoading(message = 'Loading feedback…') {
    const content = panel.querySelector('[data-feedback-content]');
    clear(content);
    const state = element('div', '', 'empty-state-admin');
    const icon = element('i', '', 'fa-solid fa-spinner fa-spin');
    state.append(icon, element('p', message));
    content.appendChild(state);
  }

  function renderError(error) {
    const content = panel.querySelector('[data-feedback-content]');
    clear(content);
    const state = element('div', '', 'empty-state-admin');
    state.append(
      element('i', '', 'fa-solid fa-triangle-exclamation'),
      element('p', error?.message || 'Feedback information could not be loaded.'),
    );
    const retry = button('Try again', 'btn btn-primary btn-sm');
    retry.addEventListener('click', loadActiveSection);
    state.appendChild(retry);
    content.appendChild(state);
  }

  function table(headers) {
    const wrap = element('div', '', 'table-wrap');
    const tableNode = element('table');
    const head = element('thead');
    const row = element('tr');
    for (const header of headers) row.appendChild(element('th', header));
    head.appendChild(row);
    const body = element('tbody');
    tableNode.append(head, body);
    wrap.appendChild(tableNode);
    return { wrap, body };
  }

  function cell(text = '') {
    return element('td', text == null ? '' : String(text));
  }

  function actionsCell() {
    const td = element('td');
    const actions = element('div', '', 'actions-cell');
    actions.style.flexWrap = 'wrap';
    td.appendChild(actions);
    return { td, actions };
  }

  async function moderateRating(id, action) {
    const note = window.prompt('Optional moderation note:', '') ?? null;
    if (note === null) return;
    const result = await request(`/auth/feedback/admin/ratings/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ action, note }),
    });
    ui.showNotice(result.message || 'Rating moderation updated.');
    await loadRatings();
  }

  function ratingAction(label, action, id, className = 'btn btn-outline btn-xs') {
    const node = button(label, className);
    node.addEventListener('click', async () => {
      node.disabled = true;
      try {
        await moderateRating(id, action);
      } catch (error) {
        ui.showNotice(error.message || 'Rating moderation failed.', 'error');
      } finally {
        node.disabled = false;
      }
    });
    return node;
  }

  async function loadRatings() {
    renderLoading('Loading ratings…');
    try {
      const result = await request('/auth/feedback/admin/ratings?limit=100');
      const content = panel.querySelector('[data-feedback-content]');
      clear(content);
      const { wrap, body } = table([
        'Reviewer', 'Agent', 'Source listing', 'Score', 'Comment',
        'Rating', 'Comment status', 'Submitted', 'Actions',
      ]);
      for (const rating of result.data || []) {
        const row = element('tr');
        row.appendChild(cell(rating.email_normalized));
        const agent = cell(rating.agent_name || '—');
        if (rating.agent_id) {
          const link = element('a', rating.agent_name || `Agent ${rating.agent_id}`);
          link.href = `/agent-profile?id=${encodeURIComponent(rating.agent_id)}`;
          link.target = '_blank';
          link.rel = 'noopener';
          clear(agent);
          agent.appendChild(link);
        }
        row.appendChild(agent);
        const listing = cell(rating.listing_title || '—');
        if (rating.listing_id) {
          const link = element('a', rating.listing_title || `Listing ${rating.listing_id}`);
          link.href = `/listing-detail?id=${encodeURIComponent(rating.listing_id)}`;
          link.target = '_blank';
          link.rel = 'noopener';
          clear(listing);
          listing.appendChild(link);
        }
        row.appendChild(listing);
        row.appendChild(cell(`${rating.score} / 5`));
        const comment = cell(rating.comment || '—');
        comment.style.maxWidth = '320px';
        comment.style.whiteSpace = 'normal';
        row.appendChild(comment);
        const ratingStatus = cell();
        ratingStatus.appendChild(badge(rating.rating_status));
        row.appendChild(ratingStatus);
        const commentStatus = cell();
        commentStatus.appendChild(badge(rating.comment_status));
        row.appendChild(commentStatus);
        row.appendChild(cell(displayDate(rating.submitted_at)));
        const action = actionsCell();
        action.actions.append(
          ratingAction('Approve score', 'approve_rating', rating.id, 'btn btn-success btn-xs'),
          ratingAction('Reject score', 'reject_rating', rating.id),
          ratingAction('Remove score', 'remove_rating', rating.id, 'btn btn-danger btn-xs'),
          ratingAction('Restore', 'restore_rating', rating.id),
        );
        if (rating.comment) {
          action.actions.append(
            ratingAction('Approve comment', 'approve_comment', rating.id, 'btn btn-success btn-xs'),
            ratingAction('Hide comment', 'hide_comment', rating.id),
            ratingAction('Delete comment', 'delete_comment', rating.id, 'btn btn-danger btn-xs'),
          );
        }
        row.appendChild(action.td);
        body.appendChild(row);
      }
      if (!body.children.length) {
        const row = element('tr');
        const empty = cell('No ratings have been submitted.');
        empty.colSpan = 9;
        empty.className = 'empty-state-admin';
        row.appendChild(empty);
        body.appendChild(row);
      }
      content.appendChild(wrap);
    } catch (error) {
      renderError(error);
    }
  }

  function evidenceLine(label, value) {
    const row = element('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = 'minmax(150px, 34%) 1fr';
    row.style.gap = '12px';
    row.style.padding = '9px 0';
    row.style.borderBottom = '1px solid #e2e8f0';
    const term = element('strong', label);
    term.style.color = '#334155';
    const detail = element('span', value == null || value === '' ? '—' : String(value));
    detail.style.overflowWrap = 'anywhere';
    row.append(term, detail);
    return row;
  }

  function evidenceHeading(text) {
    const heading = element('h3', text);
    heading.style.margin = '20px 0 4px';
    heading.style.fontSize = '1rem';
    return heading;
  }

  async function viewReportEvidence(id) {
    const result = await request(`/auth/feedback/admin/reports/${encodeURIComponent(id)}/evidence`);
    const data = result.data;
    const modal = ui.openDialog(`Report ${data.publicId || data.id}`);
    modal.body.append(
      evidenceHeading('Verified reporter'),
      evidenceLine('Google email at submission', data.reporter?.googleEmail),
      evidenceLine('Current Google email', data.reporter?.currentGoogleEmail),
      evidenceLine('Email verified', data.reporter?.emailVerified ? 'Yes' : 'No'),
      evidenceLine('First authenticated', displayDate(data.reporter?.firstAuthenticatedAt)),
      evidenceLine('Last authenticated', displayDate(data.reporter?.lastAuthenticatedAt)),
      evidenceHeading('Private network evidence'),
      evidenceLine('IP address', data.networkEvidence?.ipAddress),
      evidenceLine('Country', data.networkEvidence?.country),
      evidenceLine('Browser signature', data.networkEvidence?.userAgent),
      evidenceLine('Cloudflare request ID', data.networkEvidence?.requestId),
      evidenceLine(
        'Evidence retention',
        data.networkEvidence?.retained
          ? data.networkEvidence?.expiresAt
            ? `Exact evidence expires ${displayDate(data.networkEvidence.expiresAt)}`
            : 'Retained while this case remains open'
          : 'Exact network evidence has expired and was deleted',
      ),
    );
    if (data.listing) {
      modal.body.append(
        evidenceHeading('Reported listing'),
        evidenceLine('Listing', data.listing.title || data.listing.id),
        evidenceLine('Public state', data.listing.approvalStatus),
        evidenceLine('Owner name', data.listing.ownerName),
        evidenceLine('Owner email', data.listing.ownerEmail),
        evidenceLine('Moderation action', data.listing.action),
        evidenceLine('Actioned at', displayDate(data.listing.actionedAt)),
        evidenceLine('Actioned by', data.listing.actionedByEmail || data.listing.actionedByName),
      );
    }
    if (data.handledBy) {
      modal.body.append(
        evidenceHeading('Case handling'),
        evidenceLine('Handled by', data.handledBy.email || data.handledBy.name),
        evidenceLine('Resolution note', data.resolutionNote),
      );
    }
    const close = button('Close', 'btn btn-primary');
    close.addEventListener('click', () => modal.dialog.close());
    modal.footer.appendChild(close);
  }

  async function moderateReport(id, action) {
    const promptText = action === 'investigate'
      ? 'Optional investigation note:'
      : action === 'take_down_listing'
        ? 'Required takedown reason (at least 10 characters):'
        : 'Required resolution note (at least 10 characters):';
    const note = window.prompt(promptText, '') ?? null;
    if (note === null) return;
    if (action !== 'investigate' && note.trim().length < 10) {
      ui.showNotice('A factual moderation note of at least 10 characters is required.', 'error');
      return;
    }
    if (action === 'take_down_listing' && !window.confirm(
      'Remove this listing from the public catalogue? The listing record will be retained and can later be re-approved from the Listings tab.',
    )) return;
    const result = await request(`/auth/feedback/admin/report-cases/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ action, note }),
    });
    ui.showNotice(result.message || 'Report status updated.');
    await loadReports();
  }

  function reportAction(label, action, id, className = 'btn btn-outline btn-xs') {
    const node = button(label, className);
    node.addEventListener('click', async () => {
      node.disabled = true;
      try {
        await moderateReport(id, action);
      } catch (error) {
        ui.showNotice(error.message || 'Report update failed.', 'error');
      } finally {
        node.disabled = false;
      }
    });
    return node;
  }

  function evidenceAction(id) {
    const node = button('Reporter details', 'btn btn-outline btn-xs');
    node.addEventListener('click', async () => {
      node.disabled = true;
      try {
        await viewReportEvidence(id);
      } catch (error) {
        ui.showNotice(error.message || 'Reporter details could not be loaded.', 'error');
      } finally {
        node.disabled = false;
      }
    });
    return node;
  }

  async function loadReports() {
    renderLoading('Loading reports…');
    try {
      const result = await request('/auth/feedback/admin/reports?limit=100');
      const content = panel.querySelector('[data-feedback-content]');
      clear(content);
      const { wrap, body } = table([
        'Reporter', 'Target', 'Reason', 'Details', 'Status', 'Submitted', 'Actions',
      ]);
      for (const report of result.data || []) {
        const row = element('tr');
        const reporter = cell();
        reporter.append(
          element('div', report.email_normalized || 'Verified Google reviewer'),
          element('small', 'Verified Google account'),
        );
        row.appendChild(reporter);
        const target = cell();
        const isListing = report.target_type === 'listing';
        const targetId = isListing ? report.listing_id : report.agent_id;
        const targetLabel = isListing ? report.listing_title : report.agent_name;
        if (targetId) {
          const link = element('a', targetLabel || `${report.target_type} ${targetId}`);
          link.href = isListing
            ? `/listing-detail?id=${encodeURIComponent(targetId)}`
            : `/agent-profile?id=${encodeURIComponent(targetId)}`;
          link.target = '_blank';
          link.rel = 'noopener';
          target.appendChild(link);
        } else target.textContent = targetLabel || 'Removed target';
        row.appendChild(target);
        row.appendChild(cell(String(report.reason_code || '').replaceAll('_', ' ')));
        const details = cell(report.details || '—');
        details.style.maxWidth = '360px';
        details.style.whiteSpace = 'normal';
        row.appendChild(details);
        const status = cell();
        status.appendChild(badge(report.status));
        row.appendChild(status);
        row.appendChild(cell(displayDate(report.submitted_at)));
        const action = actionsCell();
        action.actions.append(
          evidenceAction(report.id),
          reportAction('Investigate', 'investigate', report.id),
          reportAction('Resolve', 'resolve', report.id, 'btn btn-success btn-xs'),
          reportAction('Dismiss', 'dismiss', report.id),
        );
        if (isListing && report.listing_id) {
          action.actions.appendChild(
            reportAction('Take down listing', 'take_down_listing', report.id, 'btn btn-danger btn-xs'),
          );
        }
        row.appendChild(action.td);
        body.appendChild(row);
      }
      if (!body.children.length) {
        const row = element('tr');
        const empty = cell('No reports have been submitted.');
        empty.colSpan = 7;
        empty.className = 'empty-state-admin';
        row.appendChild(empty);
        body.appendChild(row);
      }
      content.appendChild(wrap);
    } catch (error) {
      renderError(error);
    }
  }

  async function banReviewer(reviewer, removeFeedback) {
    const reason = window.prompt(
      removeFeedback
        ? 'Reason for banning this email and removing its ratings:'
        : 'Reason for banning this email:',
      '',
    );
    if (!reason) return;
    const result = await request('/auth/feedback/admin/bans', {
      method: 'POST',
      body: JSON.stringify({
        reviewerId: reviewer.id,
        email: reviewer.email_normalized,
        reason,
        removeFeedback,
      }),
    });
    ui.showNotice(result.message || 'Reviewer ban applied.');
    await loadReviewers();
  }

  async function unbanReviewer(banId) {
    const result = await request(`/auth/feedback/admin/bans/${encodeURIComponent(banId)}`, {
      method: 'DELETE',
    });
    ui.showNotice(result.message || 'Reviewer unbanned.');
    await loadReviewers();
  }

  async function loadReviewers() {
    renderLoading('Loading reviewers…');
    try {
      const result = await request('/auth/feedback/admin/reviewers');
      const content = panel.querySelector('[data-feedback-content]');
      clear(content);
      const { wrap, body } = table([
        'Email', 'Status', 'Ratings', 'Approved', 'Pending',
        'Reports', 'Last activity', 'Actions',
      ]);
      for (const reviewer of result.data || []) {
        const row = element('tr');
        row.appendChild(cell(reviewer.email_normalized));
        const status = cell();
        status.appendChild(badge(reviewer.active_ban_id ? 'Banned' : 'Active'));
        row.appendChild(status);
        row.appendChild(cell(reviewer.total_ratings));
        row.appendChild(cell(reviewer.approved_ratings));
        row.appendChild(cell(reviewer.pending_ratings));
        row.appendChild(cell(reviewer.reports_submitted));
        row.appendChild(cell(displayDate(reviewer.last_authenticated_at)));
        const action = actionsCell();
        if (reviewer.active_ban_id) {
          const unban = button('Unban', 'btn btn-success btn-xs');
          unban.addEventListener('click', async () => {
            unban.disabled = true;
            try {
              await unbanReviewer(reviewer.active_ban_id);
            } catch (error) {
              ui.showNotice(error.message || 'Reviewer could not be unbanned.', 'error');
            } finally {
              unban.disabled = false;
            }
          });
          action.actions.appendChild(unban);
        } else {
          const ban = button('Ban email', 'btn btn-danger btn-xs');
          ban.addEventListener('click', () => banReviewer(reviewer, false));
          const banAndRemove = button('Ban + remove ratings', 'btn btn-danger btn-xs');
          banAndRemove.addEventListener('click', () => banReviewer(reviewer, true));
          action.actions.append(ban, banAndRemove);
        }
        row.appendChild(action.td);
        body.appendChild(row);
      }
      if (!body.children.length) {
        const row = element('tr');
        const empty = cell('No Google reviewer identities have been created.');
        empty.colSpan = 8;
        empty.className = 'empty-state-admin';
        row.appendChild(empty);
        body.appendChild(row);
      }
      content.appendChild(wrap);
    } catch (error) {
      renderError(error);
    }
  }

  async function loadOverview() {
    try {
      const result = await request('/auth/feedback/admin/overview');
      const overview = panel.querySelector('[data-feedback-overview]');
      clear(overview);
      const entries = [
        ['Pending ratings', result.data.pendingRatings],
        ['Open reports', result.data.openReports],
        ['Reviewers', result.data.reviewers],
        ['Active bans', result.data.activeBans],
      ];
      for (const [label, value] of entries) {
        const card = element('div', '', 'stat-card');
        card.append(
          element('div', label, 'stat-label'),
          element('div', String(value || 0), 'stat-value'),
        );
        overview.appendChild(card);
      }
    } catch (error) {
      console.error('Feedback overview could not be loaded.', error);
    }
  }

  function loadActiveSection() {
    loadOverview();
    if (activeSection === 'reports') return loadReports();
    if (activeSection === 'reviewers') return loadReviewers();
    return loadRatings();
  }

  function buildPanel() {
    panel = element('section');
    panel.id = 'feedbackAdminPanel';
    panel.style.display = 'none';

    const heading = element('div', '', 'toolbar');
    const copy = element('div');
    copy.append(
      element('h2', 'Ratings, reports and reviewer moderation'),
      element('p', 'Review verified Google reporter details, investigate reports, take down unsafe listings without deleting them, and manage reviewer email bans.'),
    );
    const tabs = element('div');
    tabs.style.display = 'flex';
    tabs.style.gap = '8px';
    tabs.style.flexWrap = 'wrap';
    tabs.append(
      sectionButton('Ratings', 'ratings'),
      sectionButton('Reports', 'reports'),
      sectionButton('Reviewers', 'reviewers'),
    );
    tabs.firstElementChild.classList.add('tab-active');
    tabs.firstElementChild.classList.remove('btn-outline');
    heading.append(copy, tabs);

    const overview = element('div', '', 'stats-grid');
    overview.dataset.feedbackOverview = 'true';
    const content = element('div');
    content.dataset.feedbackContent = 'true';
    panel.append(heading, overview, content);
    return panel;
  }

  async function mount() {
    if (mounted) return;
    const session = await fetch('/auth/session', {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }).then(response => response.json()).catch(() => null);
    if (!session?.success || session.data?.user?.role !== 'admin') return;

    const usersTab = document.getElementById('tabUsers');
    const tabContainer = usersTab?.parentElement;
    const adminBody = document.querySelector('.admin-body');
    if (!tabContainer || !adminBody) return;

    mounted = true;
    feedbackTab = button('⭐ Feedback', 'btn btn-sm tab-btn btn-outline');
    feedbackTab.id = 'tabFeedback';
    feedbackTab.style.borderRadius = '8px';
    feedbackTab.addEventListener('click', showFeedbackPanel);
    tabContainer.appendChild(feedbackTab);
    adminBody.appendChild(buildPanel());
    installTabBridge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount().catch(console.error), { once: true });
  } else mount().catch(console.error);
})();
