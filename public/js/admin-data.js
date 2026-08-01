/* PrimeProp admin dashboard data/session corrections.
 * Loaded after the legacy admin bundle so it can preserve the existing UI and
 * replace only the broken data-loading and session behaviors.
 */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  if (!client) throw new Error('PrimePropClient must load before the admin dashboard.');

  const originalLoadUsersData = window.loadUsersData;
  const originalResetUserForm = window.resetUserForm;
  const originalApiFetch = window.apiFetch;

  function adminFetch(url, options) {
    return originalApiFetch(url, options);
  }

  function messageFrom(reason, fallback) {
    return reason instanceof Error && reason.message ? reason.message : fallback;
  }

  window.doLogout = function doLogout() {
    client.logout().catch(error => {
      console.error(error);
      if (typeof window.showToast === 'function') {
        window.showToast(messageFrom(error, 'Logout failed. Please try again.'), 'error');
      }
    });
  };

  window.loadData = async function loadData() {
    const [listingsResult, statsResult] = await Promise.allSettled([
      client.fetchAllListings({}, adminFetch),
      client.requestJson('/api/stats', {}, adminFetch),
    ]);

    if (listingsResult.status === 'fulfilled') {
      allListings = listingsResult.value;
      if (activeTab === 'listings') renderTable();
    } else {
      console.error(listingsResult.reason);
      client.renderTableError(
        'tableBody',
        10,
        messageFrom(listingsResult.reason, 'Listings could not be loaded from the database.'),
        window.loadData,
      );
    }

    if (statsResult.status === 'fulfilled') {
      const stats = statsResult.value.data || {};
      document.getElementById('statTotal').textContent = String(stats.total ?? 0);
      document.getElementById('statRent').textContent = String(stats.rent ?? 0);
      document.getElementById('statSale').textContent = String(stats.sale ?? 0);
      document.getElementById('statLand').textContent = String(stats.land ?? 0);
      document.getElementById('statFeatured').textContent = String(stats.featured ?? 0);
    } else {
      console.error(statsResult.reason);
      for (const id of ['statTotal', 'statRent', 'statSale', 'statLand', 'statFeatured']) {
        const element = document.getElementById(id);
        if (element) element.textContent = '—';
      }
    }
  };

  window.loadDistrictsData = async function loadDistrictsData() {
    try {
      const body = await client.requestJson('/api/districts', {}, adminFetch);
      const rows = Array.isArray(body.data) ? body.data : [];
      allDistricts = rows.map(district => ({
        ...district,
        linkType: district.linkType || district.link_type || 'all',
      }));
      renderDistrictsTable();
    } catch (error) {
      console.error(error);
      client.renderTableError(
        'districtsTableBody',
        6,
        messageFrom(error, 'Districts could not be loaded from the database.'),
        window.loadDistrictsData,
      );
      if (typeof window.showToast === 'function') {
        window.showToast('Districts could not be loaded.', 'error');
      }
    }
  };

  window.loadUsersData = async function loadUsersData() {
    try {
      const body = await client.requestJson('/auth/users', {}, adminFetch);
      const normalizedBody = {
        ...body,
        data: (Array.isArray(body.data) ? body.data : []).map(user => ({
          ...user,
          account_status: user.account_status || 'pending',
        })),
      };

      const savedApiFetch = window.apiFetch;
      window.apiFetch = async function interceptedApiFetch(url, options) {
        if (url === '/auth/users' && (!options || !options.method || options.method === 'GET')) {
          return new Response(JSON.stringify(normalizedBody), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return savedApiFetch(url, options);
      };

      try {
        await originalLoadUsersData();
      } finally {
        window.apiFetch = savedApiFetch;
      }
    } catch (error) {
      console.error(error);
      client.renderTableError(
        'usersTableBody',
        8,
        messageFrom(error, 'Users could not be loaded from the database.'),
        window.loadUsersData,
      );
      if (typeof window.showToast === 'function') {
        window.showToast('Users could not be loaded.', 'error');
      }
    }
  };

  if (typeof originalResetUserForm === 'function') {
    window.resetUserForm = function resetUserForm() {
      originalResetUserForm();
      const role = document.getElementById('userFormRole');
      if (role) role.value = 'agent';
    };
  }

  function refreshAfterAuthenticatedBootstrap(attempt = 0) {
    if (AUTH_USER) {
      window.loadData();
      if (activeTab === 'districts') window.loadDistrictsData();
      if (activeTab === 'users') window.loadUsersData();
      return;
    }
    if (attempt < 100) {
      setTimeout(() => refreshAfterAuthenticatedBootstrap(attempt + 1), 50);
    }
  }

  refreshAfterAuthenticatedBootstrap();
})();
