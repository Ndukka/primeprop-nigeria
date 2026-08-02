/* Shared reviewer-session and feedback UI helpers. */
(() => {
  'use strict';

  const SESSION_PATH = '/auth/feedback/session';
  const ACTIONS = new Set(['rate-agent', 'report-agent', 'report-listing']);
  const ACTION_LABELS = {
    'rate-agent': ['rate this agent', 'rate & review this agent'],
    'report-agent': ['report this agent', 'report agent'],
    'report-listing': ['report this listing'],
  };
  const runtimeNonce = document.currentScript?.nonce || '';
  let csrfToken = '';
  let pendingIntent = '';
  let resumeTimer = 0;

  function ensureStyles() {
    if (document.getElementById('primepropFeedbackStyles')) return;
    const style = document.createElement('style');
    style.id = 'primepropFeedbackStyles';
    if (runtimeNonce) style.nonce = runtimeNonce;
    style.textContent = `
      #primepropFeedbackDialog {
        position: fixed;
        inset: 0;
        margin: auto;
        width: min(640px, calc(100vw - 32px));
        max-width: 640px;
        max-height: min(760px, calc(100vh - 32px));
        padding: 0;
        border: 0;
        border-radius: 20px;
        overflow: hidden;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 28px 90px rgba(15, 23, 42, 0.28);
      }
      #primepropFeedbackDialog::backdrop {
        background: rgba(15, 23, 42, 0.58);
        backdrop-filter: blur(3px);
      }
      .primeprop-feedback-shell {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        max-height: min(760px, calc(100vh - 32px));
      }
      .primeprop-feedback-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 22px 24px 18px;
        background: #ffffff;
      }
      .primeprop-feedback-title-wrap {
        display: grid;
        gap: 5px;
      }
      .primeprop-feedback-kicker {
        margin: 0;
        color: #64748b;
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      #primepropFeedbackDialogTitle {
        margin: 0;
        font-size: clamp(1.2rem, 2vw, 1.5rem);
        line-height: 1.25;
      }
      .primeprop-feedback-close {
        flex: 0 0 40px;
        width: 40px;
        height: 40px;
        padding: 0;
        border-radius: 999px;
        display: inline-grid;
        place-items: center;
        font-size: 1.35rem;
      }
      .primeprop-feedback-body {
        overflow: auto;
        padding: 22px 24px 8px;
        border-top: 1px solid #e2e8f0;
      }
      .primeprop-feedback-footer {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        padding: 16px 24px 20px;
        border-top: 1px solid #e2e8f0;
        background: #ffffff;
      }
      .primeprop-feedback-field {
        display: grid;
        gap: 8px;
        margin-bottom: 18px;
      }
      .primeprop-feedback-field > label {
        color: #334155;
        font-size: 0.84rem;
        font-weight: 750;
      }
      .primeprop-feedback-field > input,
      .primeprop-feedback-field > select,
      .primeprop-feedback-field > textarea {
        width: 100%;
        min-height: 44px;
        padding: 11px 12px;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        background: #ffffff;
        color: #0f172a;
        font: inherit;
        box-sizing: border-box;
      }
      .primeprop-feedback-field > textarea {
        min-height: 132px;
        resize: vertical;
      }
      .primeprop-feedback-field > input:focus,
      .primeprop-feedback-field > select:focus,
      .primeprop-feedback-field > textarea:focus {
        outline: 3px solid rgba(37, 99, 235, 0.18);
        border-color: #2563eb;
      }
      #primepropFeedbackNotice {
        position: fixed;
        left: 50%;
        bottom: 22px;
        z-index: 10000;
        width: min(520px, calc(100vw - 32px));
        transform: translateX(-50%);
        padding: 14px 18px;
        border-radius: 12px;
        background: #0f172a;
        color: #ffffff;
        font-weight: 650;
        box-shadow: 0 16px 44px rgba(15, 23, 42, 0.24);
        text-align: center;
      }
      #primepropFeedbackNotice[data-type="error"] { background: #991b1b; }
      @media (max-width: 640px) {
        #primepropFeedbackDialog {
          width: calc(100vw - 20px);
          max-height: calc(100vh - 20px);
          border-radius: 16px;
        }
        .primeprop-feedback-shell { max-height: calc(100vh - 20px); }
        .primeprop-feedback-header { padding: 18px 18px 15px; }
        .primeprop-feedback-body { padding: 18px 18px 6px; }
        .primeprop-feedback-footer {
          padding: 14px 18px 18px;
          flex-direction: column-reverse;
        }
        .primeprop-feedback-footer .btn { width: 100%; justify-content: center; }
      }
    `;
    document.head.appendChild(style);
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
    const data = (await jsonResponse(response)).data;
    csrfToken = data?.authenticated && typeof data.csrfToken === 'string'
      ? data.csrfToken
      : '';
    return data;
  }

  function feedbackHeaders() {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Authorization: `Feedback ${csrfToken}`,
    };
  }

  async function sendWrite(path, body, method) {
    return fetch(path, {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: feedbackHeaders(),
      body: JSON.stringify(body || {}),
    });
  }

  async function write(path, body, method = 'POST') {
    if (!csrfToken) await session();
    try {
      return await jsonResponse(await sendWrite(path, body, method));
    } catch (error) {
      if (error?.status !== 403 || error?.message !== 'CSRF token mismatch.') throw error;
      csrfToken = '';
      const state = await session();
      if (!state?.authenticated || !csrfToken) throw error;
      return jsonResponse(await sendWrite(path, body, method));
    }
  }

  function currentReturnPath(action = pendingIntent) {
    const url = new URL(window.location.href);
    url.searchParams.delete('feedbackAuth');
    url.searchParams.delete('feedbackAction');
    if (ACTIONS.has(action)) url.searchParams.set('feedbackAction', action);
    return `${url.pathname}${url.search}`;
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
    ensureStyles();
    const previous = document.getElementById('primepropFeedbackNotice');
    if (previous) previous.remove();
    const notice = document.createElement('div');
    notice.id = 'primepropFeedbackNotice';
    notice.dataset.type = type;
    notice.setAttribute('role', type === 'error' ? 'alert' : 'status');
    notice.textContent = message;
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
    ensureStyles();
    const existing = document.getElementById('primepropFeedbackDialog');
    if (existing) existing.remove();

    const dialog = document.createElement('dialog');
    dialog.id = 'primepropFeedbackDialog';
    dialog.setAttribute('aria-labelledby', 'primepropFeedbackDialogTitle');

    const shell = document.createElement('div');
    shell.className = 'primeprop-feedback-shell';
    const header = document.createElement('div');
    header.className = 'primeprop-feedback-header';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'primeprop-feedback-title-wrap';
    const kicker = document.createElement('p');
    kicker.className = 'primeprop-feedback-kicker';
    kicker.textContent = 'PrimeProp feedback';
    const heading = document.createElement('h2');
    heading.id = 'primepropFeedbackDialogTitle';
    heading.textContent = title;
    titleWrap.append(kicker, heading);

    const close = button('×', 'btn btn-outline primeprop-feedback-close');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => dialog.close());
    header.append(titleWrap, close);

    const body = document.createElement('div');
    body.className = 'primeprop-feedback-body';
    const footer = document.createElement('div');
    footer.className = 'primeprop-feedback-footer';

    shell.append(header, body, footer);
    dialog.appendChild(shell);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    window.setTimeout(() => close.focus(), 0);
    return { dialog, body, footer };
  }

  function field(label, control) {
    const group = document.createElement('div');
    group.className = 'primeprop-feedback-field';
    const text = document.createElement('label');
    text.textContent = label;
    if (!control.id) control.id = `primepropFeedbackField${crypto.randomUUID()}`;
    text.htmlFor = control.id;
    group.append(text, control);
    return group;
  }

  function inferAction(target) {
    const control = target instanceof Element ? target.closest('button, a') : null;
    const label = (control?.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!label) return '';
    for (const [action, labels] of Object.entries(ACTION_LABELS)) {
      if (labels.some(candidate => label.includes(candidate))) return action;
    }
    return '';
  }

  function resumeFeedbackAction(action) {
    if (!ACTIONS.has(action)) return;
    window.clearTimeout(resumeTimer);
    const started = Date.now();
    const attempt = () => {
      const labels = ACTION_LABELS[action] || [];
      const control = [...document.querySelectorAll('button, a')].find(element => {
        const text = (element.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
        return labels.some(label => text.includes(label));
      });
      if (control instanceof HTMLElement) {
        pendingIntent = '';
        control.click();
        return;
      }
      if (Date.now() - started < 10000) {
        resumeTimer = window.setTimeout(attempt, 150);
      } else {
        pendingIntent = '';
        showNotice('The requested feedback form is not available for this profile or listing.', 'error');
      }
    };
    attempt();
  }

  function consumeAuthStatus() {
    const url = new URL(window.location.href);
    const status = url.searchParams.get('feedbackAuth');
    const action = url.searchParams.get('feedbackAction') || '';
    if (!status) return;
    if (status === 'success' && ACTIONS.has(action)) pendingIntent = action;
    url.searchParams.delete('feedbackAuth');
    url.searchParams.delete('feedbackAction');
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
    if (status === 'success' && pendingIntent) resumeFeedbackAction(pendingIntent);
  }

  document.addEventListener('click', event => {
    const action = inferAction(event.target);
    if (action) pendingIntent = action;
  }, true);

  ensureStyles();
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
