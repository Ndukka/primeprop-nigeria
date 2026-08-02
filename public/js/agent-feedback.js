/* Public agent ratings, comments and agent report controls. */
(() => {
  'use strict';

  const feedback = window.PrimePropFeedback;
  if (!feedback) return;
  const agentIdValue = new URLSearchParams(window.location.search).get('id');
  if (!agentIdValue || !/^\d+$/.test(agentIdValue)) return;
  const agentId = Number(agentIdValue);
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

  function stars(score) {
    const wrapper = element('span', '', 'agent-feedback-stars');
    wrapper.setAttribute('aria-label', `${score} out of 5 stars`);
    wrapper.style.color = '#d97706';
    wrapper.style.letterSpacing = '2px';
    wrapper.textContent = `${'★'.repeat(Math.max(0, Math.min(5, score)))}${'☆'.repeat(Math.max(0, 5 - score))}`;
    return wrapper;
  }

  function intro(text) {
    const paragraph = element('p', text);
    paragraph.style.margin = '0 0 18px';
    paragraph.style.color = '#475569';
    paragraph.style.lineHeight = '1.55';
    return paragraph;
  }

  async function openRating(profile) {
    const reviewer = await feedback.requireReviewer();
    if (!reviewer) return;
    const listings = Array.isArray(profile.listings) ? profile.listings : [];
    if (!listings.length) {
      feedback.showNotice('This agent has no approved listing available as the rating source.', 'error');
      return;
    }

    const modal = feedback.openDialog(`Rate ${profile.name || 'this agent'}`);
    modal.body.appendChild(intro(
      'Choose the approved listing connected to your experience. Every rating is reviewed before it affects the public score.',
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
    modal.body.appendChild(feedback.field('Comment', comment));

    const privacy = element(
      'p',
      `Submitting as ${reviewer.reviewerLabel}. Only a server-masked version of this email can appear publicly.`,
    );
    privacy.style.fontSize = '.8rem';
    privacy.style.color = '#64748b';
    modal.body.appendChild(privacy);

    const cancel = feedback.button('Cancel', 'btn btn-outline');
    cancel.addEventListener('click', () => modal.dialog.close());
    const submit = feedback.button('Submit for review', 'btn btn-primary');
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
    const reviewer = await feedback.requireReviewer();
    if (!reviewer) return;
    const modal = feedback.openDialog(`Report ${profile.name || 'this agent'}`);
    modal.body.appendChild(intro(
      'This report is private. PrimeProp administrators will investigate it before taking any account or listing action.',
    ));

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

  function feedbackButton(label, iconClass) {
    const button = feedback.button('', 'btn btn-outline');
    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, document.createTextNode(` ${label}`));
    return button;
  }

  function renderRatings(data) {
    const section = element('section', '', 'agent-profile-section agent-feedback-section');
    section.id = 'agent-ratings';
    section.style.marginTop = '28px';

    const headingRow = element('div');
    headingRow.style.display = 'flex';
    headingRow.style.justifyContent = 'space-between';
    headingRow.style.alignItems = 'flex-start';
    headingRow.style.gap = '20px';
    headingRow.style.flexWrap = 'wrap';
    const copy = element('div');
    copy.append(
      element('h2', 'Agent ratings'),
      element('p', 'Ratings come from Google-authenticated reviewers and are published only after administrator moderation.'),
    );
    headingRow.appendChild(copy);

    const summary = element('div');
    summary.style.textAlign = 'right';
    const average = element('strong', data.total ? String(data.average.toFixed(1)) : '—');
    average.style.display = 'block';
    average.style.fontSize = '2rem';
    average.style.color = '#0f172a';
    summary.append(average, stars(data.total ? Math.round(data.average) : 0));
    const total = element('div', `${data.total} approved rating${data.total === 1 ? '' : 's'}`);
    total.style.fontSize = '.82rem';
    total.style.color = '#64748b';
    total.style.marginTop = '4px';
    summary.appendChild(total);
    headingRow.appendChild(summary);
    section.appendChild(headingRow);

    if (!data.total) {
      const empty = element('p', 'No approved ratings have been published for this agent yet.');
      empty.style.marginTop = '20px';
      empty.style.padding = '18px';
      empty.style.background = '#f8fafc';
      empty.style.borderRadius = '10px';
      section.appendChild(empty);
      return section;
    }

    const distribution = element('div');
    distribution.style.display = 'grid';
    distribution.style.gap = '8px';
    distribution.style.marginTop = '22px';
    for (let value = 5; value >= 1; value -= 1) {
      const count = Number(data.distribution?.[value] || 0);
      const row = element('div');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '46px 1fr 34px';
      row.style.gap = '10px';
      row.style.alignItems = 'center';
      row.appendChild(element('span', `${value} ★`));
      const track = element('div');
      track.style.height = '8px';
      track.style.background = '#e2e8f0';
      track.style.borderRadius = '999px';
      const fill = element('div');
      fill.style.height = '100%';
      fill.style.width = `${data.total ? Math.round((count / data.total) * 100) : 0}%`;
      fill.style.background = '#d97706';
      fill.style.borderRadius = '999px';
      track.appendChild(fill);
      row.append(track, element('span', String(count)));
      distribution.appendChild(row);
    }
    section.appendChild(distribution);

    const comments = Array.isArray(data.comments) ? data.comments : [];
    if (comments.length) {
      const list = element('div');
      list.style.display = 'grid';
      list.style.gap = '14px';
      list.style.marginTop = '26px';
      for (const item of comments) {
        const card = element('article');
        card.style.padding = '16px';
        card.style.background = '#f8fafc';
        card.style.borderRadius = '12px';
        const meta = element('div');
        meta.style.display = 'flex';
        meta.style.justifyContent = 'space-between';
        meta.style.gap = '12px';
        meta.style.marginBottom = '9px';
        const identity = element('strong', item.reviewerLabel || 'Google-authenticated reviewer');
        const date = new Date(item.submittedAt);
        const dateText = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
        meta.append(identity, element('span', dateText));
        card.append(meta, stars(Number(item.score || 0)), element('p', item.comment || ''));
        list.appendChild(card);
      }
      section.appendChild(list);
    }
    return section;
  }

  function apply(profile, ratings) {
    if (applied) return;
    const root = document.getElementById('agentProfileContent');
    const heroActions = root?.querySelector('.agent-profile-hero-actions');
    const listings = root?.querySelector('#active-listings');
    if (!root || !heroActions || !listings) return;
    applied = true;

    if (Array.isArray(profile.listings) && profile.listings.length) {
      const rate = feedbackButton('Rate this agent', 'fa-solid fa-star');
      rate.addEventListener('click', () => openRating(profile));
      heroActions.appendChild(rate);
    }
    const report = feedbackButton('Report agent', 'fa-regular fa-flag');
    report.addEventListener('click', () => openReport(profile));
    heroActions.appendChild(report);
    listings.before(renderRatings(ratings));
  }

  async function tryApply() {
    if (applied) return;
    const root = document.getElementById('agentProfileContent');
    if (!root?.querySelector('.agent-profile-hero') || !root.querySelector('#active-listings')) return;
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
