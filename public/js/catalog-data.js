/* PrimeProp public catalogue database corrections. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  if (!client) throw new Error('PrimePropClient must load before the catalogue runtime.');

  let catalogueError = null;
  const listingCache = new Map();
  const originalRenderCards = window.renderCards;

  function cacheKey(filters) {
    return JSON.stringify(Object.entries(filters || {}).sort(([a], [b]) => a.localeCompare(b)));
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
  }

  const fourPlus = document.querySelector('.filter-tag-btn[data-bedrooms="4"]');
  if (fourPlus && /4\+/.test(fourPlus.textContent || '')) {
    fourPlus.setAttribute('data-bedrooms', '4+');
  }
})();
