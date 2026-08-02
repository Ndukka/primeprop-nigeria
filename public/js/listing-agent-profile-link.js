/* Makes the database-backed listing contact card open its public agent profile. */
(() => {
  'use strict';

  let applied = false;

  function listingId() {
    const value = new URLSearchParams(window.location.search).get('id');
    return value && /^\d+$/.test(value) ? value : '';
  }

  async function loadAgentId(id) {
    const listingResponse = await fetch(`/api/listings/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const listingBody = await listingResponse.json().catch(() => null);
    if (!listingResponse.ok || !listingBody?.success) return null;

    const candidateId = Number(listingBody.data?.agent?.id || 0);
    if (!Number.isSafeInteger(candidateId) || candidateId <= 0) return null;

    const profileResponse = await fetch(`/auth/public-agents/${encodeURIComponent(candidateId)}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!profileResponse.ok) return null;
    const profileBody = await profileResponse.json().catch(() => null);
    return profileBody?.success && Number(profileBody.data?.id) === candidateId
      ? candidateId
      : null;
  }

  function resetCardStyle(card) {
    card.style.transform = '';
    card.style.boxShadow = '';
    card.style.borderColor = '';
  }

  function emphasizeCard(card) {
    card.style.transform = 'translateY(-2px)';
    card.style.boxShadow = '0 8px 24px rgba(0,0,0,0.06)';
    card.style.borderColor = '#cbd5e1';
  }

  function applyLink(card, agentId) {
    if (applied || card.dataset.agentProfileId) return;
    applied = true;
    card.dataset.agentProfileId = String(agentId);
    card.classList.add('agent-card-linkable');
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', 'View full agent profile');
    card.style.cursor = 'pointer';
    card.style.transition = 'transform .2s ease, box-shadow .2s ease, border-color .2s ease';

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
    card.addEventListener('mouseenter', () => emphasizeCard(card));
    card.addEventListener('mouseleave', () => resetCardStyle(card));
    card.addEventListener('focus', () => emphasizeCard(card));
    card.addEventListener('blur', () => resetCardStyle(card));

    if (!card.querySelector('.agent-profile-card-link')) {
      const link = document.createElement('a');
      link.className = 'agent-profile-card-link';
      link.href = url;
      link.style.display = 'inline-flex';
      link.style.alignItems = 'center';
      link.style.justifyContent = 'center';
      link.style.gap = '7px';
      link.style.width = '100%';
      link.style.marginTop = '12px';
      link.style.color = '#0f172a';
      link.style.fontSize = '.84rem';
      link.style.fontWeight = '700';
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
