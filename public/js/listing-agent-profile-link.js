/* Makes the database-backed listing contact card open its public agent profile. */
(() => {
  'use strict';

  let applied = false;

  function listingId() {
    const value = new URLSearchParams(window.location.search).get('id');
    return value && /^\d+$/.test(value) ? value : '';
  }

  async function loadAgentId(id) {
    const response = await fetch(`/api/listings/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) return null;
    const agentId = Number(body.data?.agent?.id || 0);
    return Number.isSafeInteger(agentId) && agentId > 0 ? agentId : null;
  }

  function applyLink(card, agentId) {
    if (applied || card.dataset.agentProfileId) return;
    applied = true;
    card.dataset.agentProfileId = String(agentId);
    card.classList.add('agent-card-linkable');
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', 'View full agent profile');

    const url = `/agent-profile?id=${encodeURIComponent(agentId)}`;
    const open = () => window.location.assign(url);
    card.addEventListener('click', event => {
      if (event.target.closest('a, button, input, select, textarea')) return;
      open();
    });
    card.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('a, button, input, select, textarea')) return;
      event.preventDefault();
      open();
    });

    if (!card.querySelector('.agent-profile-card-link')) {
      const link = document.createElement('a');
      link.className = 'agent-profile-card-link';
      link.href = url;
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-user-check';
      link.append(icon, document.createTextNode(' View full agent profile'));
      card.appendChild(link);
    }
  }

  async function tryApply() {
    if (applied) return;
    const id = listingId();
    const card = document.querySelector('#detailContent .detail-sidebar .detail-contact-card');
    if (!id || !card) return;

    try {
      const agentId = await loadAgentId(id);
      if (agentId) applyLink(card, agentId);
    } catch (error) {
      console.error('Agent profile link could not be prepared.', error);
    }
  }

  const observer = new MutationObserver(() => tryApply());
  observer.observe(document.getElementById('detailContent') || document.body, {
    childList: true,
    subtree: true,
  });
  tryApply();
})();
