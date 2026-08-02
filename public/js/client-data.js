/* PrimeProp client data/session helpers.
 *
 * Centralizes JSON response validation, paginated listing retrieval, visible
 * error states, CSRF-correct logout, and shared page navigation policies.
 */
(() => {
  'use strict';

  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  const PAGE_SIZE = 100;
  const MAX_PAGES = 100;
  const MANUAL_MEDIA_FIELD_IDS = [
    'formImages',
    'districtFormImage',
    'formAgentAvatar',
    'userFormAvatar',
    'profileAvatar',
  ];

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)pp_csrf=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function normalizeOptions(options = {}) {
    const normalized = { ...options, credentials: options.credentials || 'include' };
    const method = String(normalized.method || 'GET').toUpperCase();
    const headers = new Headers(normalized.headers || {});
    const csrf = csrfToken();

    if (!SAFE_METHODS.has(method) && csrf && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', csrf);
    }

    normalized.headers = headers;
    return normalized;
  }

  async function parseJsonResponse(response, url) {
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`The server returned an invalid response for ${url}.`);
    }

    if (!response.ok || !body || body.success !== true) {
      const message = body && typeof body.message === 'string'
        ? body.message
        : `Request failed with status ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      error.url = url;
      throw error;
    }

    return body;
  }

  async function requestJson(url, options = {}, fetcher = fetch) {
    const response = await fetcher(url, normalizeOptions(options));
    try {
      return await parseJsonResponse(response, url);
    } catch (error) {
      if (error && error.status === 401 && window.location.pathname !== '/login') {
        window.location.replace('/login?reason=session-expired');
      }
      throw error;
    }
  }

  async function fetchPaginatedListings(endpoint, filters = {}, fetcher = fetch) {
    const baseParams = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value === '' || value === null || value === undefined || value === 'all') continue;
      baseParams.set(key, String(value));
    }
    baseParams.set('limit', String(PAGE_SIZE));

    const listings = [];
    const seen = new Set();
    let page = 1;
    let totalPages = 1;

    do {
      if (page > MAX_PAGES) {
        throw new Error('The listing inventory is too large to load safely in one browser request.');
      }

      const params = new URLSearchParams(baseParams);
      params.set('page', String(page));
      const url = `${endpoint}?${params.toString()}`;
      const body = await requestJson(url, {}, fetcher);
      const rows = Array.isArray(body.data) ? body.data : [];

      for (const row of rows) {
        const key = row && row.id !== undefined ? String(row.id) : JSON.stringify(row);
        if (seen.has(key)) continue;
        seen.add(key);
        listings.push(row);
      }

      const reportedPages = Number(body.totalPages);
      totalPages = Number.isInteger(reportedPages) && reportedPages > 0 ? reportedPages : 1;
      page += 1;
    } while (page <= totalPages);

    return listings;
  }

  function fetchAllListings(filters = {}, fetcher = fetch) {
    return fetchPaginatedListings('/api/listings', filters, fetcher);
  }

  function fetchAllAdminListings(filters = {}, fetcher = fetch) {
    return fetchPaginatedListings('/auth/admin-listings', filters, fetcher);
  }

  function clearElement(element) {
    if (!element) return;
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function retryButton(retry) {
    if (typeof retry !== 'function') return null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary btn-sm';
    button.textContent = 'Try again';
    button.addEventListener('click', retry);
    return button;
  }

  function renderTableError(target, columnCount, message, retry) {
    const tbody = typeof target === 'string' ? document.getElementById(target) : target;
    if (!tbody) return;
    clearElement(tbody);

    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columnCount;
    cell.className = 'empty-state-admin';

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-triangle-exclamation';
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('p');
    text.textContent = message || 'This information could not be loaded.';

    cell.append(icon, text);
    const button = retryButton(retry);
    if (button) cell.appendChild(button);
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  function renderGridError(target, message, retry) {
    const container = typeof target === 'string' ? document.getElementById(target) : target;
    if (!container) return;
    clearElement(container);

    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'empty-icon';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-triangle-exclamation';
    icon.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(icon);

    const heading = document.createElement('h3');
    heading.textContent = 'Listings could not be loaded';
    const text = document.createElement('p');
    text.textContent = message || 'Please check your connection and try again.';

    wrapper.append(iconWrap, heading, text);
    const button = retryButton(retry);
    if (button) wrapper.appendChild(button);
    container.appendChild(wrapper);
  }

  async function logout() {
    const response = await fetch('/auth/logout', normalizeOptions({ method: 'POST' }));
    await parseJsonResponse(response, '/auth/logout');
    window.location.replace('/login?loggedOut=1');
  }

  function hideManualMediaField(field) {
    if (!(field instanceof HTMLElement) || field.dataset.ppUploadOnly === 'true') return;
    field.dataset.ppUploadOnly = 'true';
    field.hidden = true;
    field.tabIndex = -1;
    field.setAttribute('aria-hidden', 'true');
    if ('readOnly' in field) field.readOnly = true;

    if (field.id === 'profileAvatar') {
      const group = field.closest('.form-group');
      if (group) group.hidden = true;
      return;
    }

    const label = field.previousElementSibling;
    if (label instanceof HTMLLabelElement && /paste|url/i.test(label.textContent || '')) {
      label.hidden = true;
    }
  }

  function applyUploadOnlyMediaPolicy() {
    for (const id of MANUAL_MEDIA_FIELD_IDS) {
      hideManualMediaField(document.getElementById(id));
    }
  }

  function applyFooterSignInLinks() {
    const links = document.querySelectorAll('footer .footer-col a');
    for (const link of links) {
      if ((link.textContent || '').trim().toLowerCase() !== 'sign in') continue;
      link.setAttribute('href', '/login');
    }
  }

  function applySharedPagePolicies() {
    applyUploadOnlyMediaPolicy();
    applyFooterSignInLinks();
  }

  function startSharedPagePolicies() {
    applySharedPagePolicies();
    const observer = new MutationObserver(() => applySharedPagePolicies());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startSharedPagePolicies, { once: true });
  } else {
    startSharedPagePolicies();
  }

  window.PrimePropClient = Object.freeze({
    csrfToken,
    requestJson,
    fetchPaginatedListings,
    fetchAllListings,
    fetchAllAdminListings,
    renderTableError,
    renderGridError,
    logout,
  });
})();