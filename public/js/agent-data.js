/* PrimeProp agent dashboard data/session corrections. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  if (!client) throw new Error('PrimePropClient must load before the agent dashboard.');

  const originalApiFetch = window.apiFetch;

  function agentFetch(url, options) {
    return originalApiFetch(url, options);
  }

  function normalizeListing(listing) {
    return {
      ...listing,
      property_type: listing.property_type || listing.propertyType || 'apartment',
      price_unit: listing.price_unit || listing.priceUnit || '',
    };
  }

  window.doLogout = function doLogout() {
    client.logout().catch(error => {
      console.error(error);
      if (typeof window.showToast === 'function') {
        window.showToast(error.message || 'Logout failed. Please try again.', 'error');
      }
    });
  };

  window.loadData = async function loadData() {
    try {
      const body = await client.requestJson('/auth/my-listings', {}, agentFetch);
      myListings = (Array.isArray(body.data) ? body.data : []).map(normalizeListing);
      renderTable();
      document.getElementById('statTotal').textContent = String(myListings.length);
      document.getElementById('statFeatured').textContent = String(myListings.filter(l => l.featured).length);
      document.getElementById('statVerified').textContent = String(myListings.filter(l => l.verified).length);
    } catch (error) {
      console.error(error);
      client.renderTableError(
        'tableBody',
        7,
        error.message || 'Your listings could not be loaded from the database.',
        window.loadData,
      );
      for (const id of ['statTotal', 'statFeatured', 'statVerified']) {
        const element = document.getElementById(id);
        if (element) element.textContent = '—';
      }
      if (typeof window.showToast === 'function') {
        window.showToast('Your listings could not be loaded.', 'error');
      }
    }
  };

  function refreshAfterAuthenticatedBootstrap(attempt = 0) {
    if (USER) {
      window.loadData();
      return;
    }
    if (attempt < 100) {
      setTimeout(() => refreshAfterAuthenticatedBootstrap(attempt + 1), 50);
      return;
    }
    window.location.replace('/login?reason=session-expired');
  }

  refreshAfterAuthenticatedBootstrap();
})();
