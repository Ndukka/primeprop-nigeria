/* Listing-detail feedback controls for registered agents and public listings. */
(() => {
  'use strict';

  const feedback = window.PrimePropFeedback;
  if (!feedback) return;
  let applied = false;

  const REPORT_OPTIONS = [
    ['misleading_information', 'Misleading information'],
    ['suspected_fraud', 'Suspected fraud'],
    ['impersonation', 'Impersonation'],
    ['property_unavailable', 'Property is unavailable'],
    ['incorrect_price', 'Incorrect price'],
    ['duplicate_listing', 'Duplicate listing'],
    ['harassment', 'Harassment'],
    ['unauthorised_agent', 'Unauthorised agent'],
    ['other', 'Other'],
  ];

  function listingId() {
    const query = new URLSearchParams(window.location.search).get('id');
    if (query && /^\d+$/.test(query)) return query;
    const match = window.location.pathname.match(/\/listing-detail-(\d+)(?:\.html)?$/);
    return match ? match[1] : '';
  }

  async function context(id) {
    const response = await fetch(`/auth/feedback/listings/${encodeURIComponent(id)}/context`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) throw new Error(body?.message || 'Feedback options are unavailable.');
    return body.data;
  }

  function paragraph(text, className = '') {
    const element = document.createElement('p');
    if (className) element.className = className;
    element.textContent = text;
    element.style.margin = '0 0 18px';
    element.style.color = '#475569';
    element.style.lineHeight = '1.55';
    return element;
  }

  async function openRating(data) {
    const reviewer = await feedback.requireReviewer(feedback.currentReturnPath('rate-agent'));
    if (!reviewer) return;
    const modal = feedback.openDialog(`Rate and review ${data.agentName || 'this agent'}`);
    modal.body.appendChild(paragraph(
      `Your rating is linked to “${data.listingTitle}”. The score and optional comment appear only after separate administrator review.`,
    ));

    const score = document.createElement('select');
    score.required = true;
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
    comment.placeholder = 'Optional: describe your experience. Do not include email addresses, telephone numbers or links.';
    modal.body.appendChild(feedback.field('Review comment', comment));

    const privacy = paragraph(
      `Submitting as ${reviewer.reviewerLabel}. The public profile shows only a server-masked version of this email.`,
      'primeprop-feedback-privacy',
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
          agentId: data.agentId,
          listingId: data.listingId,
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

  async function openReport(targetType, targetId, targetLabel) {
    const action = targetType === 'listing' ? 'report-listing' : 'report-agent';
    const reviewer = await feedback.requireReviewer(feedback.currentReturnPath(action));
    if (!reviewer) return;
    const modal = feedback.openDialog(`Report ${targetLabel}`);
    modal.body.appendChild(paragraph(
      'Reports are private and reviewed by a PrimeProp administrator. A report does not automatically remove a listing or suspend an agent.',
    ));

    const privacy = paragraph(
      `Submitting as ${reviewer.reviewerLabel}. Administrators can see the verified Google email used for this report and limited network evidence—IP address, country, browser signature and Cloudflare request ID—for investigation and abuse prevention. Exact network evidence is deleted 90 days after the case closes.`,
      'primeprop-feedback-privacy',
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
          targetType,
          targetId,
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

  function actionButton(label, iconClass, action) {
    const button = feedback.button('', 'btn btn-outline btn-sm primeprop-feedback-action');
    button.dataset.feedbackAction = action;
    button.style.width = '100%';
    button.style.justifyContent = 'center';
    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, document.createTextNode(` ${label}`));
    return button;
  }

  function actionHost() {
    return document.querySelector('#detailContent .detail-sidebar .detail-contact-card')
      || document.querySelector('.detail-sidebar .detail-contact-card')
      || document.querySelector('#detailContent .detail-sidebar')
      || document.querySelector('.detail-sidebar')
      || document.getElementById('detailContent');
  }

  function apply(host, data) {
    if (applied || host.dataset.feedbackActions === 'true') return;
    applied = true;
    host.dataset.feedbackActions = 'true';

    const panel = document.createElement('section');
    panel.className = 'primeprop-listing-feedback-panel';
    panel.setAttribute('aria-label', 'Ratings, reviews and safety');
    panel.style.marginTop = '18px';
    panel.style.paddingTop = '18px';
    panel.style.borderTop = '1px solid #e2e8f0';

    const label = document.createElement('h3');
    label.textContent = 'Ratings, reviews and safety';
    label.style.margin = '0 0 6px';
    label.style.fontSize = '.95rem';
    label.style.color = '#0f172a';
    const description = paragraph(
      'Share a moderated experience or privately flag a listing or agent for administrator review.',
    );
    description.style.fontSize = '.8rem';
    description.style.marginBottom = '12px';
    const actions = document.createElement('div');
    actions.style.display = 'grid';
    actions.style.gap = '8px';

    if (data.rateable && data.agentId) {
      const rate = actionButton('Rate & review this agent', 'fa-solid fa-star', 'rate-agent');
      rate.addEventListener('click', () => openRating(data));
      const reportAgent = actionButton('Report this agent', 'fa-regular fa-flag', 'report-agent');
      reportAgent.addEventListener('click', () => openReport('agent', data.agentId, data.agentName || 'this agent'));
      actions.append(rate, reportAgent);
    } else {
      const unavailable = paragraph(
        'Ratings are unavailable for this listing because it is not linked to a registered, active and published agent profile.',
      );
      unavailable.style.padding = '11px 12px';
      unavailable.style.marginBottom = '8px';
      unavailable.style.borderRadius = '10px';
      unavailable.style.background = '#f8fafc';
      unavailable.style.fontSize = '.78rem';
      actions.appendChild(unavailable);
    }

    const reportListing = actionButton('Report this listing', 'fa-solid fa-triangle-exclamation', 'report-listing');
    reportListing.addEventListener('click', () => openReport('listing', data.listingId, 'this listing'));
    actions.appendChild(reportListing);
    panel.append(label, description, actions);
    host.appendChild(panel);
  }

  async function tryApply() {
    if (applied) return;
    const id = listingId();
    const host = actionHost();
    if (!id || !host) return;
    try {
      apply(host, await context(id));
    } catch (error) {
      console.error('Listing feedback controls could not be prepared.', error);
    }
  }

  const observer = new MutationObserver(() => tryApply());
  observer.observe(document.getElementById('detailContent') || document.body, {
    childList: true,
    subtree: true,
  });
  tryApply();
})();
