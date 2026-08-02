/* Public agent ratings, comments and agent report controls. */
(() => {
  'use strict';

  const feedback = window.PrimePropFeedback;
  if (!feedback) return;
  const params = new URLSearchParams(window.location.search);
  const agentIdValue = params.get('id');
  const agentId = agentIdValue && /^\d+$/.test(agentIdValue) ? Number(agentIdValue) : 0;
  let applied = false;

  const REPORT_OPTIONS = [
    ['misleading_information', 'Misleading information'],
    ['suspected_fraud', 'Suspected fraud'],
    ['impersonation', 'Impersonation'],
    ['harassment', 'Harassment'],
    ['unauthorised_agent', 'Unauthorised agent'],
    ['other', 'Other'],
  ];

  async function getJson(path) {
    const response = await fetch(path, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success || !body.data) {
      throw new Error(body?.message || 'Agent feedback is unavailable.');
    }
    return body.data;
  }

  function element(tag, text, className = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function paragraph(text) {
    const node = element('p', text);
    node.style.margin = '0 0 18px';
    node.style.color = '#475569';
    node.style.lineHeight = '1.55';
    return node;
  }

  function stars(score) {
    const rounded = Math.max(0, Math.min(5, Math.round(Number(score) || 0)));
    const wrapper = element('span', '', 'agent-feedback-stars');
    wrapper.setAttribute('aria-label', `${Number(score || 0).toFixed(1)} out of 5 stars`);
    wrapper.style.color = '#d97706';
    wrapper.style.letterSpacing = '2px';
    wrapper.textContent = `${'★'.repeat(rounded)}${'☆'.repeat(5 - rounded)}`;
    return wrapper;
  }

  function feedbackButton(label, iconClass, action) {
    const button = feedback.button('', 'btn btn-outline primeprop-feedback-action');
    button.dataset.feedbackAction = action;
    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, document.createTextNode(` ${label}`));
    return button;
  }

  async function openRating(profile) {
    const reviewer = await feedback.requireReviewer(feedback.currentReturnPath('rate-agent'));
    if (!reviewer) return;
    const listings = Array.isArray(profile.listings) ? profile.listings : [];
    if (!listings.length) {
      feedback.showNotice('This agent has no approved listing available as the rating source.', 'error');
      return;
    }

    const modal = feedback.openDialog(`Rate and review ${profile.name || 'this agent'}`);
    modal.body.appendChild(paragraph(
      'Choose the approved listing connected to your experience. The score and optional comment are moderated separately before publication.',
    ));

    const listing = document.createElement('select');
    for (const item of listings) {
      const option = document.createElement('option');
      option.value = String(item.id);
      option.textContent = item.title || `Listing ${item.id}`;
      listing.appendChild(option);
    }
    modal.body.appendChild(feedback.field('Related listing', listing));

    const score = document.createElement('select');
    for (let value = 5; value >= 1; value -= 1) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${value} star${value === 1 ? '' : 's'}`;
      score.appendChild(option);
    }
    modal.body.appendChild(feedback.field('Rating', score));

    const comment = document.createElement('textarea');
    comment.rows = 5;
    comment.maxLength = 1000;
    comment.placeholder = 'Optional: describe your experience without email addresses, telephone numbers or links.';
    modal.body.appendChild(feedback.field('Review comment', comment));

    const privacy = paragraph(
      `Submitting as ${reviewer.reviewerLabel}. Only a server-masked version of this email can appear publicly.`,
    );
    privacy.style.fontSize = '.82rem';
    modal.body.appendChild(privacy);

    const cancel = feedback.button('Cancel', 'btn btn-outline');
    cancel.addEventListener('click', () => modal.dialog.close());
    const submit = feedback.button('Submit rating and review', 'btn btn-primary');
    submit.addEventListener('click', async () => {
      submit.disabled = true;
      try {
        const result = await feedback.write('/auth/feedback/ratings', {
          agentId,
          listingId: Number(listing.value),
          score: Number(score.value),
          comment: comment.value,
        });
        modal.dialog.close();
        feedback.showNotice(result.message || 'Rating submitted for review.');
      } catch (error) {
        feedback.showNotice(error.message || 'Rating could not be submitted.', 'error');
      } finally {
        submit.disabled = false;
      }
    });
    modal.footer.append(cancel, submit);
  }

  async function openReport(profile) {
    const reviewer = await feedback.requireReviewer(feedback.currentReturnPath('report-agent'));
    if (!reviewer) return;
    const modal = feedback.openDialog(`Report ${profile.name || 'this agent'}`);
    modal.body.appendChild(paragraph(
      'This report is private. PrimeProp administrators will investigate it before taking any account or listing action.',
    ));

    const privacy = paragraph(
      `Submitting as ${reviewer.reviewerLabel}. Administrators can see the verified Google email and limited network evidence used for investigation and abuse prevention.`,
    );
    privacy.style.padding = '14px 15px';
    privacy.style.borderRadius = '12px';
    privacy.style.background = '#f8fafc';
    privacy.style.fontSize = '.82rem';
    modal.body.appendChild(privacy);

    const reason = document.createElement('select');
    for (const [value, label] of REPORT_OPTIONS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      reason.appendChild(option);
    }
    modal.body.appendChild(feedback.field('Reason', reason));

    const details = document.createElement('textarea');
    details.rows = 6;
    details.maxLength = 1500;
    details.placeholder = 'Provide factual details that will help the moderation team investigate.';
    modal.body.appendChild(feedback.field('Details', details));

    const cancel = feedback.button('Cancel', 'btn btn-outline');
    cancel.addEventListener('click', () => modal.dialog.close());
    const submit = feedback.button('Submit report', 'btn btn-primary');
    submit.addEventListener('click', async () => {
      submit.disabled = true;
      try {
        const result = await feedback.write('/auth/feedback/reports', {
          targetType: 'agent',
          targetId: agentId,
          reasonCode: reason.value,
          details: details.value,
        });
        modal.dialog.close();
        feedback.showNotice(result.message || 'Report submitted for review.');
      } catch (error) {
        feedback.showNotice(error.message || 'Report could not be submitted.', 'error');
      } finally {
        submit.disabled = false;
      }
    });
    modal.footer.append(cancel, submit);
  }

  function renderDistribution(data) {
    const distribution = element('div', '', 'agent-feedback-distribution');
    distribution.style.display = 'grid';
    distribution.style.gap = '9px';
    distribution.style.marginTop = '22px';
    for (let value = 5; value >= 1; value -= 1) {
      const count = Number(data.distribution?.[value] || 0);
      const row = element('div');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '48px minmax(0, 1fr) 36px';
      row.style.gap = '10px';
      row.style.alignItems = 'center';
      row.appendChild(element('span', `${value} ★`));
      const track = element('div');
      track.style.height = '8px';
      track.style.background = '#e2e8f0';
      track.style.borderRadius = '999px';
      track.style.overflow = 'hidden';
      const fill = element('div');
      fill.style.height = '100%';
      fill.style.width = `${data.total ? Math.round((count / data.total) * 100) : 0}%`;
      fill.style.background = '#d97706';
      track.appendChild(fill);
      row.append(track, element('span', String(count)));
      distribution.appendChild(row);
    }
    return distribution;
  }

  function renderComments(data) {
    const comments = Array.isArray(data.comments) ? data.comments : [];
    const wrapper = element('div', '', 'agent-feedback-comments');
    wrapper.style.display = 'grid';
    wrapper.style.gap = '14px';
    wrapper.style.marginTop = '26px';

    const heading = element('h3', 'Approved review comments');
    heading.style.margin = '0';
    wrapper.appendChild(heading);

    if (!comments.length) {
      const empty = paragraph('No approved written comments have been published yet.');
      empty.style.padding = '16px';
      empty.style.margin = '0';
      empty.style.borderRadius = '12px';
      empty.style.background = '#f8fafc';
      wrapper.appendChild(empty);
      return wrapper;
    }

    for (const item of comments) {
      const card = element('article', '', 'agent-feedback-comment');
      card.style.padding = '17px';
      card.style.background = '#f8fafc';
      card.style.borderRadius = '14px';
      const meta = element('div');
      meta.style.display = 'flex';
      meta.style.justifyContent = 'space-between';
      meta.style.gap = '12px';
      meta.style.marginBottom = '9px';
      meta.style.flexWrap = 'wrap';
      const identity = element('strong', item.reviewerLabel || 'Google-authenticated reviewer');
      const date = new Date(item.submittedAt);
      const dateText = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
      meta.append(identity, element('span', dateText));
      const comment = paragraph(item.comment || '');
      comment.style.margin = '10px 0 0';
      card.append(meta, stars(Number(item.score || 0)), comment);
      wrapper.appendChild(card);
    }
    return wrapper;
  }

  function renderRatings(data) {
    const section = element('section', '', 'agent-profile-section agent-feedback-section');
    section.id = 'agent-ratings';
    section.style.marginTop = '28px';

    const headingRow = element('div');
    headingRow.style.display = 'flex';
    headingRow.style.justifyContent = 'space-between';
    headingRow.style.alignItems = 'flex-start';
    headingRow.style.gap = '22px';
    headingRow.style.flexWrap = 'wrap';
    const copy = element('div');
    copy.append(
      element('h2', 'Ratings and reviews'),
      paragraph('Scores and comments come from Google-authenticated reviewers and appear only after administrator moderation.'),
    );

    const summary = element('div');
    summary.style.minWidth = '150px';
    summary.style.textAlign = 'right';
    const average = element('strong', data.total ? String(Number(data.average || 0).toFixed(1)) : '—');
    average.style.display = 'block';
    average.style.fontSize = '2.15rem';
    average.style.color = '#0f172a';
    summary.append(average, stars(data.total ? data.average : 0));
    const total = element('div', `${Number(data.total || 0)} approved rating${Number(data.total || 0) === 1 ? '' : 's'}`);
    total.style.fontSize = '.82rem';
    total.style.color = '#64748b';
    total.style.marginTop = '5px';
    summary.appendChild(total);
    headingRow.append(copy, summary);
    section.appendChild(headingRow);

    if (!data.total) {
      const empty = paragraph('No approved ratings have been published for this agent yet. You can submit the first rating using the button above.');
      empty.style.marginTop = '18px';
      empty.style.padding = '18px';
      empty.style.background = '#f8fafc';
      empty.style.borderRadius = '12px';
      section.appendChild(empty);
    } else {
      section.appendChild(renderDistribution(data));
    }
    section.appendChild(renderComments(data));
    return section;
  }

  function ensureHeroActions(root) {
    const existing = root.querySelector('.agent-profile-hero-actions');
    if (existing) return existing;
    const hero = root.querySelector('.agent-profile-hero');
    if (!hero) return null;
    const actions = element('div', '', 'agent-profile-hero-actions');
    hero.appendChild(actions);
    return actions;
  }

  function insertRatings(root, section) {
    const listings = root.querySelector('#active-listings');
    if (listings) listings.before(section);
    else root.appendChild(section);
  }

  function apply(profile, ratings) {
    if (applied) return;
    const root = document.getElementById('agentProfileContent');
    if (!root?.querySelector('.agent-profile-hero')) return;
    const heroActions = ensureHeroActions(root);
    if (!heroActions) return;
    applied = true;

    if (!heroActions.querySelector('[data-feedback-action="rate-agent"]')) {
      if (Array.isArray(profile.listings) && profile.listings.length) {
        const rate = feedbackButton('Rate & review this agent', 'fa-solid fa-star', 'rate-agent');
        rate.addEventListener('click', () => openRating(profile));
        heroActions.appendChild(rate);
      }
    }
    if (!heroActions.querySelector('[data-feedback-action="report-agent"]')) {
      const report = feedbackButton('Report this agent', 'fa-regular fa-flag', 'report-agent');
      report.addEventListener('click', () => openReport(profile));
      heroActions.appendChild(report);
    }

    const existing = root.querySelector('#agent-ratings');
    if (existing) existing.remove();
    insertRatings(root, renderRatings(ratings));
  }

  function renderLegacyNotice() {
    if (applied) return;
    const root = document.getElementById('agentProfileContent');
    if (!root?.querySelector('.agent-profile-hero')) return;
    applied = true;
    const section = element('section', '', 'agent-profile-section agent-feedback-section');
    section.id = 'agent-ratings';
    section.append(
      element('h2', 'Ratings and reviews'),
      paragraph('Ratings are unavailable for this legacy listing profile because it is not linked to a registered PrimeProp agent identity. The listing can still be reported from its property page.'),
    );
    insertRatings(root, section);
  }

  async function tryApply() {
    if (applied) return;
    const root = document.getElementById('agentProfileContent');
    if (!root?.querySelector('.agent-profile-hero')) return;
    if (!agentId) {
      renderLegacyNotice();
      return;
    }
    try {
      const [profile, ratings] = await Promise.all([
        getJson(`/auth/public-agents/${encodeURIComponent(agentId)}`),
        getJson(`/auth/feedback/agents/${encodeURIComponent(agentId)}/ratings`),
      ]);
      apply(profile, ratings);
    } catch (error) {
      console.error('Agent feedback could not be loaded.', error);
    }
  }

  const observer = new MutationObserver(() => tryApply());
  observer.observe(document.getElementById('agentProfileContent') || document.body, {
    childList: true,
    subtree: true,
  });
  tryApply();
})();
