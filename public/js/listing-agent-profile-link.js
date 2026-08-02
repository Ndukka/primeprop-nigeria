/* Makes a listing contact card open its database-backed agent profile. */
(() => {
  'use strict';

  let applied = false;

  function listingId() {
    const queryValue = new URLSearchParams(window.location.search).get('id');
    if (queryValue && /^\d+$/.test(queryValue)) return queryValue;

    const pathMatch = window.location.pathname.match(/\/listing-detail-(\d+)(?:\.html)?$/);
    return pathMatch ? pathMatch[1] : '';
  }

  async function loadProfileUrl(id) {
    const listingResponse = await fetch(`/api/listings/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const listingBody = await listingResponse.json().catch(() => null);
    if (!listingResponse.ok || !listingBody?.success || !listingBody.data) return '';

    const listing = listingBody.data;
    const agentId = Number(listing.agent?.id || 0);
    if (Number.isSafeInteger(agentId) && agentId > 0) {
      const profileResponse = await fetch(`/auth/public-agents/${encodeURIComponent(agentId)}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!profileResponse.ok) return '';
      const profileBody = await profileResponse.json().catch(() => null);
      return profileBody?.success && Number(profileBody.data?.id) === agentId
        ? `/agent-profile?id=${encodeURIComponent(agentId)}`
        : '';
    }

    const listingAgentName = String(listing.agent?.name || '').trim();
    const publicListingId = Number(listing.id || id);
    return listingAgentName && Number.isSafeInteger(publicListingId) && publicListingId > 0
      ? `/agent-profile?listing=${encodeURIComponent(publicListingId)}`
      : '';
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

  function applyLink(card, url) {
    if (applied || card.dataset.agentProfileUrl) return;
    applied = true;
    card.dataset.agentProfileUrl = url;
    card.classList.add('agent-card-linkable');
    card.style.cursor = 'pointer';
    card.style.transition = 'transform .2s ease, box-shadow .2s ease, border-color .2s ease';

    card.addEventListener('click', event => {
      if (event.target.closest('a, button, input, select, textarea')) return;
      window.location.assign(url);
    });
    card.addEventListener('mouseenter', () => emphasizeCard(card));
    card.addEventListener('mouseleave', () => resetCardStyle(card));

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
      icon.setAttribute('aria-hidden', 'true');
      link.append(icon, document.createTextNode(' View full agent profile'));
      card.appendChild(link);
    }
  }

  async function tryApply() {
    if (applied) return;
    const id = listingId();
    const card = document.querySelector('#detailContent .detail-sidebar .detail-contact-card')
      || document.querySelector('.detail-sidebar .detail-contact-card');
    if (!id || !card) return;

    try {
      const profileUrl = await loadProfileUrl(id);
      if (profileUrl) applyLink(card, profileUrl);
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
