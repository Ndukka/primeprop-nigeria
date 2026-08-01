/* PrimeProp admin dashboard data, role, and session corrections. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  if (!client) throw new Error('PrimePropClient must load before the admin dashboard.');

  const originalLoadUsersData = window.loadUsersData;
  const originalResetUserForm = window.resetUserForm;
  const originalApiFetch = window.apiFetch;

  function messageFrom(reason, fallback) {
    return reason instanceof Error && reason.message ? reason.message : fallback;
  }

  function roleAwareListingUrl(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'POST' && url === '/api/listings') return '/auth/listing-records';
    if (method === 'PUT' && /^\/api\/listings\/\d+$/.test(url)) {
      return url.replace('/api/listings/', '/auth/listing-records/');
    }
    return url;
  }

  window.apiFetch = function apiFetch(url, options = {}) {
    return originalApiFetch(roleAwareListingUrl(url, options), options);
  };

  function adminFetch(url, options) {
    return window.apiFetch(url, options);
  }

  function clear(target) {
    while (target && target.firstChild) target.removeChild(target.firstChild);
  }

  function safeMediaUrl(value) {
    return typeof value === 'string' && (value.startsWith('https://') || value.startsWith('/api/images/'));
  }

  function badge(text, type) {
    const element = document.createElement('span');
    const safeTypes = new Set(['rent', 'sale', 'land', 'featured']);
    element.className = `badge badge-${safeTypes.has(type) ? type : 'rent'}`;
    element.textContent = text;
    return element;
  }

  function actionButton(title, iconClass, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    const icon = document.createElement('i');
    icon.className = iconClass;
    button.appendChild(icon);
    button.addEventListener('click', handler);
    return button;
  }

  function filteredAdminListings() {
    const searchInput = document.getElementById('searchInput');
    const typeInput = document.getElementById('filterType');
    const cityInput = document.getElementById('filterCity');
    const search = String(searchInput?.value || '').trim().toLowerCase();
    const type = String(typeInput?.value || 'all');
    const city = String(cityInput?.value || 'all');

    return allListings.filter(listing => {
      if (type !== 'all' && listing.type !== type) return false;
      if (city !== 'all' && listing.city !== city) return false;
      if (!search) return true;
      return [listing.title, listing.location, listing.area, listing.city]
        .some(value => String(value || '').toLowerCase().includes(search));
    });
  }

  window.renderTable = function renderTable() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;
    const rows = filteredAdminListings();
    clear(tbody);

    if (rows.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 10;
      cell.className = 'empty-state-admin';
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-folder-open';
      const text = document.createElement('p');
      text.textContent = allListings.length === 0
        ? 'No listings are stored in the database.'
        : 'No listings match the selected filters.';
      cell.append(icon, text);
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }

    for (const listing of rows) {
      const row = document.createElement('tr');

      const imageCell = document.createElement('td');
      const firstImage = Array.isArray(listing.images) && listing.images.length > 0
        ? listing.images[0]
        : null;
      const imageUrl = typeof firstImage === 'string' ? firstImage : firstImage?.url;
      if (safeMediaUrl(imageUrl)) {
        const image = document.createElement('img');
        image.src = imageUrl;
        image.alt = listing.title || '';
        image.className = 'td-img';
        image.addEventListener('error', () => image.remove());
        imageCell.appendChild(image);
      } else {
        imageCell.textContent = '—';
      }
      row.appendChild(imageCell);

      const titleCell = document.createElement('td');
      titleCell.className = 'td-title';
      titleCell.title = listing.title || '';
      titleCell.textContent = listing.title || 'Untitled listing';
      row.appendChild(titleCell);

      const typeCell = document.createElement('td');
      const typeLabel = listing.type === 'land' ? 'Land' : listing.type === 'sale' ? 'For Sale' : 'For Rent';
      typeCell.appendChild(badge(typeLabel, listing.type));
      row.appendChild(typeCell);

      const priceCell = document.createElement('td');
      priceCell.style.fontWeight = '600';
      priceCell.style.whiteSpace = 'nowrap';
      priceCell.textContent = `₦${Number(listing.price || 0).toLocaleString()}`;
      if (listing.priceUnit) {
        const unit = document.createElement('small');
        unit.style.color = '#94a3b8';
        unit.style.fontWeight = '400';
        unit.textContent = ` ${listing.priceUnit}`;
        priceCell.appendChild(unit);
      }
      row.appendChild(priceCell);

      const locationCell = document.createElement('td');
      locationCell.style.color = '#64748b';
      locationCell.textContent = listing.location || '—';
      row.appendChild(locationCell);

      const bedsCell = document.createElement('td');
      bedsCell.textContent = listing.bedrooms == null ? '—' : String(listing.bedrooms);
      row.appendChild(bedsCell);

      const bathsCell = document.createElement('td');
      bathsCell.textContent = listing.bathrooms == null ? '—' : String(listing.bathrooms);
      row.appendChild(bathsCell);

      const featuredCell = document.createElement('td');
      featuredCell.appendChild(listing.featured ? badge('★ Featured', 'featured') : document.createTextNode('—'));
      row.appendChild(featuredCell);

      const verifiedCell = document.createElement('td');
      if (listing.verified) {
        verifiedCell.style.color = '#16a34a';
        const verifiedIcon = document.createElement('i');
        verifiedIcon.className = 'fa-solid fa-circle-check';
        verifiedCell.append(verifiedIcon, document.createTextNode(' Verified'));
      } else {
        verifiedCell.textContent = '—';
      }
      row.appendChild(verifiedCell);

      const actionsCell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'actions-cell';
      actions.append(
        actionButton('Edit', 'fa-solid fa-pen-to-square', 'btn btn-outline btn-xs', () => window.openEditModal(listing.id)),
        actionButton('Delete', 'fa-solid fa-trash', 'btn btn-danger btn-xs', () => window.confirmDelete(listing.id, listing.title || 'listing')),
      );
      actionsCell.appendChild(actions);
      row.appendChild(actionsCell);

      tbody.appendChild(row);
    }
  };

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
      client.fetchAllAdminListings({}, adminFetch),
      client.requestJson('/api/stats', {}, adminFetch),
    ]);

    if (listingsResult.status === 'fulfilled') {
      allListings = listingsResult.value;
      if (activeTab === 'listings') window.renderTable();
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
      window.renderDistrictsTable();
    } catch (error) {
      console.error(error);
      client.renderTableError(
        'districtsTableBody',
        6,
        messageFrom(error, 'Districts could not be loaded from the database.'),
        window.loadDistrictsData,
      );
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

      const currentApiFetch = window.apiFetch;
      window.apiFetch = async function interceptedApiFetch(url, options) {
        if (url === '/auth/users' && (!options || !options.method || options.method === 'GET')) {
          return new Response(JSON.stringify(normalizedBody), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return currentApiFetch(url, options);
      };

      try {
        await originalLoadUsersData();
      } finally {
        window.apiFetch = currentApiFetch;
      }
    } catch (error) {
      console.error(error);
      client.renderTableError(
        'usersTableBody',
        8,
        messageFrom(error, 'Users could not be loaded from the database.'),
        window.loadUsersData,
      );
    }
  };

  function addServiceApartmentOption() {
    const select = document.getElementById('formPropertyType');
    if (!select || select.querySelector('option[value="service-apartment"]')) return;
    const option = document.createElement('option');
    option.value = 'service-apartment';
    option.textContent = 'Service Apartment';
    const apartment = select.querySelector('option[value="apartment"]');
    if (apartment?.nextSibling) select.insertBefore(option, apartment.nextSibling);
    else select.appendChild(option);
  }

  if (typeof originalResetUserForm === 'function') {
    window.resetUserForm = function resetUserForm() {
      originalResetUserForm();
      const role = document.getElementById('userFormRole');
      if (role) role.value = 'agent';
    };
  }

  function refreshAfterAuthenticatedBootstrap(attempt = 0) {
    if (AUTH_USER) {
      if (AUTH_USER.role !== 'admin') {
        window.location.replace('/agent');
        return;
      }
      addServiceApartmentOption();
      window.loadData();
      if (activeTab === 'districts') window.loadDistrictsData();
      if (activeTab === 'users') window.loadUsersData();
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
