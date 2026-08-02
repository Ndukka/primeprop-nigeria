/* PrimeProp public catalogue database corrections. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  if (!client) throw new Error('PrimePropClient must load before the catalogue runtime.');

  const RETIRED_CONTACT = '2348000000000';
  let catalogueError = null;
  const listingCache = new Map();
  const originalRenderCards = window.renderCards;

  function cacheKey(filters) {
    return JSON.stringify(Object.entries(filters || {}).sort(([a], [b]) => a.localeCompare(b)));
  }

  function htmlEscape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function unavailableContactLabel() {
    const label = document.createElement('span');
    label.className = 'btn btn-outline btn-sm';
    label.setAttribute('aria-disabled', 'true');
    label.textContent = 'Contact unavailable';
    return label;
  }

  function listingIdFromLink(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) return '';
    try {
      const url = new URL(anchor.href, window.location.href);
      if (!/\/listing-detail(?:\.html)?$/.test(url.pathname)) return '';
      return /^\d+$/.test(url.searchParams.get('id') || '') ? url.searchParams.get('id') : '';
    } catch {
      return '';
    }
  }

  function listingIdForNode(node) {
    if (!(node instanceof Element)) return '';
    const card = node.closest('.property-card');
    if (card) {
      for (const anchor of card.querySelectorAll('a[href*="listing-detail"]')) {
        const id = listingIdFromLink(anchor);
        if (id) return id;
      }
    }
    const queryId = new URL(window.location.href).searchParams.get('id') || '';
    return /^\d+$/.test(queryId) ? queryId : '';
  }

  function applyContactRoutes(root, explicitListingIds = []) {
    if (!(root instanceof Document || root instanceof DocumentFragment || root instanceof Element)) return;

    const cards = root instanceof Element && root.matches('.property-card')
      ? [root]
      : Array.from(root.querySelectorAll('.property-card'));
    cards.forEach((card, index) => {
      const fallback = listingIdForNode(card);
      const id = String(explicitListingIds[index] || fallback || '');
      if (!/^\d+$/.test(id)) return;
      const whatsapp = card.querySelector('a.btn-whatsapp');
      if (whatsapp) {
        whatsapp.href = `/auth/listing-contact/${encodeURIComponent(id)}/whatsapp`;
        whatsapp.target = '_blank';
        whatsapp.rel = 'noopener';
      }
    });

    const detail = root instanceof Element && root.matches('.detail-contact-card')
      ? root
      : root.querySelector('.detail-contact-card');
    if (detail) {
      const id = listingIdForNode(detail);
      if (/^\d+$/.test(id)) {
        const whatsapp = detail.querySelector('a.btn-whatsapp');
        if (whatsapp) {
          whatsapp.href = `/auth/listing-contact/${encodeURIComponent(id)}/whatsapp`;
          whatsapp.target = '_blank';
          whatsapp.rel = 'noopener';
        }
        const call = detail.querySelector('a[href^="tel:"]');
        if (call) call.href = `/auth/listing-contact/${encodeURIComponent(id)}/call`;
      }
    }

    const retired = [];
    if (root instanceof HTMLAnchorElement && (root.getAttribute('href') || '').includes(RETIRED_CONTACT)) {
      retired.push(root);
    }
    root.querySelectorAll(`a[href*="${RETIRED_CONTACT}"]`).forEach(anchor => retired.push(anchor));
    for (const anchor of retired) {
      const id = listingIdForNode(anchor);
      if (/^\d+$/.test(id)) {
        anchor.href = anchor.classList.contains('btn-whatsapp')
          ? `/auth/listing-contact/${encodeURIComponent(id)}/whatsapp`
          : `/auth/listing-contact/${encodeURIComponent(id)}/call`;
      } else {
        anchor.replaceWith(unavailableContactLabel());
      }
    }
  }

  window.fetchListings = async function fetchListings(filters = {}) {
    const key = cacheKey(filters);
    const cached = listingCache.get(key);
    if (cached && Date.now() - cached.time < 60000) {
      catalogueError = null;
      return cached.data;
    }

    try {
      const listings = await client.fetchAllListings(filters);
      listingCache.set(key, { data: listings, time: Date.now() });
      catalogueError = null;
      return listings;
    } catch (error) {
      console.error('Catalogue fetch failed:', error);
      catalogueError = error;
      return [];
    }
  };

  window.fetchListing = async function fetchListing(id) {
    try {
      const body = await client.requestJson(`/api/listings/${encodeURIComponent(id)}`);
      return body.data || null;
    } catch (error) {
      console.error('Listing fetch failed:', error);
      return null;
    }
  };

  window.fetchStats = async function fetchStats() {
    try {
      const body = await client.requestJson('/api/stats');
      return body.data || null;
    } catch (error) {
      console.error('Stats fetch failed:', error);
      return null;
    }
  };

  window.renderCards = function renderCards(listings, containerId) {
    if (catalogueError) {
      client.renderGridError(
        containerId,
        catalogueError.message || 'The property catalogue could not be loaded from the database.',
        () => window.location.reload(),
      );
      return;
    }
    originalRenderCards(listings, containerId);
    applyContactRoutes(
      document.getElementById(containerId),
      (Array.isArray(listings) ? listings : []).map(listing => listing?.id),
    );
  };

  window.loadDistricts = async function loadDistricts() {
    const container = document.getElementById('districtsGrid');
    if (!container) return;
    try {
      const body = await client.requestJson('/auth/district-guides');
      const districts = Array.isArray(body.data) ? body.data : [];
      if (districts.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No district guides available.</p></div>';
        return;
      }
      container.innerHTML = districts.map(district => {
        const page = district.linkType === 'sale'
          ? 'properties-sale.html'
          : district.linkType === 'rent'
            ? 'properties-rent.html'
            : district.linkType === 'land'
              ? 'properties-land.html'
              : 'properties.html';
        const href = `${page}?search=${encodeURIComponent(district.name || '')}`;
        const checks = (Array.isArray(district.checks) ? district.checks : [])
          .map(check => `<div><i class="fa-solid fa-check"></i> ${htmlEscape(check)}</div>`)
          .join('');
        return `
          <a href="${href}" class="district-card district-card-link" id="district-${Number(district.id) || 0}">
            <div class="district-card-img"><img src="${htmlEscape(district.image)}" alt="${htmlEscape(district.name)}" data-pp-image-fallback="true"></div>
            <div>
              <div class="district-meta"><span class="dot"></span> ${htmlEscape(district.name)} <span>•</span> ${htmlEscape(district.city)}</div>
              <h3>${htmlEscape(district.name)}</h3>
              <p>${htmlEscape(district.description)}</p>
              <div class="district-checks">${checks}</div>
            </div>
            <div class="district-footer"><span>View properties <i class="fa-solid fa-arrow-right"></i></span></div>
          </a>`;
      }).join('');
    } catch (error) {
      console.error('District guide fetch failed:', error);
      client.renderGridError(
        container,
        error.message || 'District guides could not be loaded from the database.',
        window.loadDistricts,
      );
    }
  };

  const typeSelect = document.getElementById('typeSelect');
  if (typeSelect) {
    for (const value of ['shortlet', 'commercial']) {
      const option = typeSelect.querySelector(`option[value="${value}"]`);
      if (option) option.remove();
    }
  }

  const propertyTypeSelect = document.getElementById('propertyTypeSelect');
  if (propertyTypeSelect) {
    const terraced = propertyTypeSelect.querySelector('option[value="terraced"]');
    if (terraced) terraced.value = 'terrace';
    if (!propertyTypeSelect.querySelector('option[value="service-apartment"]')) {
      const serviceApartment = document.createElement('option');
      serviceApartment.value = 'service-apartment';
      serviceApartment.textContent = 'Service Apartment';
      const apartment = propertyTypeSelect.querySelector('option[value="apartment"]');
      if (apartment?.nextSibling) propertyTypeSelect.insertBefore(serviceApartment, apartment.nextSibling);
      else propertyTypeSelect.appendChild(serviceApartment);
    }
  }

  const fourPlus = document.querySelector('.filter-tag-btn[data-bedrooms="4"]');
  if (fourPlus && /4\+/.test(fourPlus.textContent || '')) {
    fourPlus.setAttribute('data-bedrooms', '4+');
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) applyContactRoutes(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => applyContactRoutes(document), { once: true });
  applyContactRoutes(document);
})();
