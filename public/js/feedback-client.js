/* Shared reviewer-session and feedback UI helpers. */
(() => {
  'use strict';

  const SESSION_PATH = '/auth/feedback/session';

  function cookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function jsonResponse(response) {
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) {
      const error = new Error(body?.message || `Request failed with status ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function session() {
    const response = await fetch(SESSION_PATH, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    return (await jsonResponse(response)).data;
  }

  function feedbackHeaders() {
    const csrf = cookie('pp_feedback_csrf');
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      Authorization: `Feedback ${csrf}`,
    };
  }

  async function write(path, body, method = 'POST') {
    const response = await fetch(path, {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: feedbackHeaders(),
      body: JSON.stringify(body || {}),
    });
    return jsonResponse(response);
  }

  function currentReturnPath() {
    return `${window.location.pathname}${window.location.search}`;
  }

  function reviewerLoginUrl(returnTo = currentReturnPath()) {
    return `/auth/feedback/google?returnTo=${encodeURIComponent(returnTo)}`;
  }

  async function requireReviewer(returnTo = currentReturnPath()) {
    const state = await session();
    if (!state.authenticated) {
      window.location.assign(reviewerLoginUrl(returnTo));
      return null;
    }
    if (!state.canSubmit) {
      const message = state.blockedReason === 'professional-account'
        ? 'Professional PrimeProp accounts cannot submit public agent ratings.'
        : 'This Google reviewer account cannot submit feedback.';
      showNotice(message, 'error');
      return null;
    }
    return state;
  }

  function showNotice(message, type = 'success') {
    const previous = document.getElementById('primepropFeedbackNotice');
    if (previous) previous.remove();
    const notice = document.createElement('div');
    notice.id = 'primepropFeedbackNotice';
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    notice.style.position = 'fixed';
    notice.style.right = '20px';
    notice.style.bottom = '20px';
    notice.style.zIndex = '10000';
    notice.style.maxWidth = '420px';
    notice.style.padding = '14px 18px';
    notice.style.borderRadius = '10px';
    notice.style.background = type === 'error' ? '#991b1b' : '#0f172a';
    notice.style.color = '#fff';
    notice.style.fontWeight = '650';
    notice.style.boxShadow = '0 12px 36px rgba(15,23,42,.24)';
    document.body.appendChild(notice);
    window.setTimeout(() => notice.remove(), 6000);
  }

  function button(label, className = 'btn btn-outline') {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    return element;
  }

  function openDialog(title) {
    const existing = document.getElementById('primepropFeedbackDialog');
    if (existing) existing.remove();

    const dialog = document.createElement('dialog');
    dialog.id = 'primepropFeedbackDialog';
    dialog.setAttribute('aria-labelledby', 'primepropFeedbackDialogTitle');
    dialog.style.width = 'min(620px, calc(100% - 32px))';
    dialog.style.maxHeight = 'calc(100vh - 48px)';
    dialog.style.padding = '0';
    dialog.style.border = '0';
    dialog.style.borderRadius = '16px';
    dialog.style.boxShadow = '0 24px 80px rgba(15,23,42,.28)';
    dialog.style.overflow = 'auto';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.gap = '16px';
    header.style.padding = '20px 22px';
    header.style.borderBottom = '1px solid #e2e8f0';

    const heading = document.createElement('h2');
    heading.id = 'primepropFeedbackDialogTitle';
    heading.textContent = title;
    heading.style.margin = '0';
    heading.style.fontSize = '1.15rem';

    const close = button('×', 'btn btn-outline');
    close.setAttribute('aria-label', 'Close');
    close.style.width = '38px';
    close.style.height = '38px';
    close.style.padding = '0';
    close.style.fontSize = '1.4rem';
    close.addEventListener('click', () => dialog.close());
    header.append(heading, close);

    const body = document.createElement('div');
    body.style.padding = '22px';
    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.justifyContent = 'flex-end';
    footer.style.gap = '10px';
    footer.style.padding = '16px 22px';
    footer.style.borderTop = '1px solid #e2e8f0';

    dialog.append(header, body, footer);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    return { dialog, body, footer };
  }

  function field(label, control) {
    const group = document.createElement('div');
    group.style.display = 'grid';
    group.style.gap = '7px';
    group.style.marginBottom = '16px';
    const text = document.createElement('label');
    text.textContent = label;
    text.style.fontSize = '.82rem';
    text.style.fontWeight = '700';
    text.style.color = '#334155';
    control.style.width = '100%';
    control.style.padding = '10px 12px';
    control.style.border = '1px solid #cbd5e1';
    control.style.borderRadius = '8px';
    control.style.font = 'inherit';
    group.append(text, control);
    return group;
  }

  function consumeAuthStatus() {
    const url = new URL(window.location.href);
    const status = url.searchParams.get('feedbackAuth');
    if (!status) return;
    url.searchParams.delete('feedbackAuth');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    const messages = {
      success: ['Google reviewer sign-in completed.', 'success'],
      cancelled: ['Google sign-in was cancelled.', 'error'],
      banned: ['This Google reviewer account cannot submit feedback.', 'error'],
      'professional-account': ['Agent and administrator identities cannot submit public ratings.', 'error'],
      'identity-conflict': ['This Google email is already linked to another reviewer identity.', 'error'],
      'invalid-state': ['The sign-in request expired or could not be verified. Please try again.', 'error'],
      'invalid-token': ['Google identity verification failed. Please try again.', 'error'],
      'invalid-identity': ['A verified Google email is required.', 'error'],
      'token-exchange-failed': ['Google sign-in could not be completed. Please try again.', 'error'],
      'configuration-error': ['Google reviewer authentication is not configured yet.', 'error'],
    };
    const entry = messages[status] || ['Google reviewer sign-in could not be completed.', 'error'];
    showNotice(entry[0], entry[1]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', consumeAuthStatus, { once: true });
  } else consumeAuthStatus();

  window.PrimePropFeedback = Object.freeze({
    session,
    write,
    currentReturnPath,
    reviewerLoginUrl,
    requireReviewer,
    showNotice,
    button,
    openDialog,
    field,
  });
})();
