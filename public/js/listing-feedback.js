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

  function intro(text) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    paragraph.style.margin = '0 0 18px';
    paragraph.style.color = '#475569';
    paragraph.style.lineHeight = '1.55';
    return paragraph;
  }

  async function openRating(data) {
    const reviewer = await feedback.requireReviewer();
    if (!reviewer) return;
    const modal = feedback.openDialog(`Rate ${data.agentName || 'this agent'}`);
    modal.body.appendChild(intro(
      `Your rating is linked to “${data.listingTitle}”. It will appear only after administrator review.`,
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
    modal.body.appendChild(feedback.field('Comment', comment));

    const privacy = document.createElement('p');
    privacy.textContent = `Submitting as ${reviewer.reviewerLabel}. The public profile will show only a server-masked version of this email.`;
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
    const reviewer = await feedback.requireReviewer();
    if (!reviewer) return;
    const modal = feedback.openDialog(`Report ${targetLabel}`);
    modal.body.appendChild(intro(
      'Reports are private and reviewed by a PrimeProp administrator. A report does not automatically remove a listing or suspend an agent.',
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

  function actionButton(label, iconClass) {
    const button = feedback.button('', 'btn btn-outline btn-sm');
    button.style.width = '100%';
    button.style.justifyContent = 'center';
    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, document.createTextNode(` ${label}`));
    return button;
  }

  function apply(card, data) {
    if (applied || card.dataset.feedbackActions === 'true') return;
    applied = true;
    card.dataset.feedbackActions = 'true';

    const divider = document.createElement('div');
    divider.style.height = '1px';
    divider.style.background = '#e2e8f0';
    divider.style.margin = '16px 0';
    const label = document.createElement('p');
    label.textContent = 'Feedback and safety';
    label.style.margin = '0 0 10px';
    label.style.fontWeight = '750';
    label.style.fontSize = '.82rem';
    label.style.color = '#334155';
    const actions = document.createElement('div');
    actions.style.display = 'grid';
    actions.style.gap = '8px';

    if (data.rateable && data.agentId) {
      const rate = actionButton('Rate this agent', 'fa-solid fa-star');
      rate.addEventListener('click', () => openRating(data));
      const reportAgent = actionButton('Report this agent', 'fa-regular fa-flag');
      reportAgent.addEventListener('click', () => openReport('agent', data.agentId, data.agentName || 'this agent'));
      actions.append(rate, reportAgent);
    }

    const reportListing = actionButton('Report this listing', 'fa-solid fa-triangle-exclamation');
    reportListing.addEventListener('click', () => openReport('listing', data.listingId, 'this listing'));
    actions.appendChild(reportListing);
    card.append(divider, label, actions);
  }

  async function tryApply() {
    if (applied) return;
    const id = listingId();
    const card = document.querySelector('#detailContent .detail-sidebar .detail-contact-card')
      || document.querySelector('.detail-sidebar .detail-contact-card');
    if (!id || !card) return;
    try {
      apply(card, await context(id));
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
