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

  function unavailableContactLabel() {
    const label = document.createElement('span');
    label.className = 'btn btn-outline btn-sm';
    label.setAttribute('aria-disabled', 'true');
    label.textContent = 'Contact unavailable';
    return label;
  }

  function neutralizeRetiredContacts(root) {
    if (!(root instanceof Document || root instanceof DocumentFragment || root instanceof Element)) return;
    const anchors = [];
    if (root instanceof HTMLAnchorElement && (root.getAttribute('href') || '').includes(RETIRED_CONTACT)) {
      anchors.push(root);
    }
    root.querySelectorAll(`a[href*="${RETIRED_CONTACT}"]`).forEach(anchor => anchors.push(anchor));
    for (const anchor of anchors) anchor.replaceWith(unavailableContactLabel());
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
    neutralizeRetiredContacts(document.getElementById(containerId));
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
      for (const node of record.addedNodes) neutralizeRetiredContacts(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => neutralizeRetiredContacts(document), { once: true });
  neutralizeRetiredContacts(document);
})();
