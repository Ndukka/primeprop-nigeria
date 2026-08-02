/* PrimeProp admin dashboard data, role, and session corrections. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  if (!client) throw new Error('PrimePropClient must load before the admin dashboard.');

  const originalResetUserForm = window.resetUserForm;
  const originalApiFetch = window.apiFetch;
  let adminUsers = [];

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
    const safeTypes = new Set(['rent', 'sale', 'land', 'featured', 'all']);
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

  function emptyTable(target, columnCount, text) {
    const tbody = document.getElementById(target);
    if (!tbody) return;
    clear(tbody);
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columnCount;
    cell.className = 'empty-state-admin';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-folder-open';
    const message = document.createElement('p');
    message.textContent = text;
    cell.append(icon, message);
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  function filteredAdminListings() {
    const search = String(document.getElementById('searchInput')?.value || '').trim().toLowerCase();
    const type = String(document.getElementById('filterType')?.value || 'all');
    const city = String(document.getElementById('filterCity')?.value || 'all');

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
      emptyTable(
        'tableBody',
        10,
        allListings.length === 0
          ? 'No listings are stored in the database.'
          : 'No listings match the selected filters.',
      );
      return;
    }

    for (const listing of rows) {
      const row = document.createElement('tr');
      const imageCell = document.createElement('td');
      const firstImage = Array.isArray(listing.images) && listing.images.length > 0 ? listing.images[0] : null;
      const imageUrl = typeof firstImage === 'string' ? firstImage : firstImage?.url;
      if (safeMediaUrl(imageUrl)) {
        const image = document.createElement('img');
        image.src = imageUrl;
        image.alt = listing.title || '';
        image.className = 'td-img';
        image.addEventListener('error', () => image.remove());
        imageCell.appendChild(image);
      } else imageCell.textContent = '—';
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

      for (const value of [listing.location || '—', listing.bedrooms ?? '—', listing.bathrooms ?? '—']) {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        row.appendChild(cell);
      }

      const featuredCell = document.createElement('td');
      featuredCell.appendChild(listing.featured ? badge('★ Featured', 'featured') : document.createTextNode('—'));
      row.appendChild(featuredCell);

      const verifiedCell = document.createElement('td');
      if (listing.verified) {
        verifiedCell.style.color = '#16a34a';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-circle-check';
        verifiedCell.append(icon, document.createTextNode(' Verified'));
      } else verifiedCell.textContent = '—';
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

  window.renderDistrictsTable = function renderDistrictsTable() {
    const tbody = document.getElementById('districtsTableBody');
    if (!tbody) return;
    clear(tbody);
    if (allDistricts.length === 0) {
      emptyTable('districtsTableBody', 6, 'No districts are stored in the database.');
      return;
    }

    for (const district of allDistricts) {
      const row = document.createElement('tr');
      const imageCell = document.createElement('td');
      if (safeMediaUrl(district.image)) {
        const image = document.createElement('img');
        image.src = district.image;
        image.alt = district.name || '';
        image.className = 'td-img';
        image.addEventListener('error', () => image.remove());
        imageCell.appendChild(image);
      } else imageCell.textContent = '—';
      row.appendChild(imageCell);

      const nameCell = document.createElement('td');
      nameCell.className = 'td-title';
      nameCell.textContent = district.name || 'Unnamed district';
      row.appendChild(nameCell);

      const cityCell = document.createElement('td');
      cityCell.textContent = district.city || '—';
      row.appendChild(cityCell);

      const checksCell = document.createElement('td');
      const checks = Array.isArray(district.checks) ? district.checks : [];
      if (checks.length === 0) checksCell.textContent = '—';
      else {
        for (const check of checks) {
          const item = badge(String(check), 'land');
          item.style.marginRight = '4px';
          checksCell.appendChild(item);
        }
      }
      row.appendChild(checksCell);

      const linkCell = document.createElement('td');
      linkCell.appendChild(badge(district.linkType || 'all', district.linkType || 'all'));
      row.appendChild(linkCell);

      const actionsCell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'actions-cell';
      actions.append(
        actionButton('Edit', 'fa-solid fa-pen-to-square', 'btn btn-outline btn-xs', () => window.openDistrictModal(district.id)),
        actionButton('Delete', 'fa-solid fa-trash', 'btn btn-danger btn-xs', () => window.confirmDeleteDistrict(district.id, district.name || 'district')),
      );
      actionsCell.appendChild(actions);
      row.appendChild(actionsCell);
      tbody.appendChild(row);
    }
  };

  window.renderUsersTable = function renderUsersTable() {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    clear(tbody);
    if (adminUsers.length === 0) {
      emptyTable('usersTableBody', 8, 'No users are stored in the database.');
      return;
    }

    for (const user of adminUsers) {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.style.fontWeight = '600';
      nameCell.textContent = user.name || 'Unnamed user';
      row.appendChild(nameCell);

      const emailCell = document.createElement('td');
      emailCell.textContent = user.email || '—';
      row.appendChild(emailCell);

      const roleCell = document.createElement('td');
      roleCell.appendChild(badge(user.role || 'agent', user.role === 'admin' ? 'sale' : 'rent'));
      row.appendChild(roleCell);

      const statusCell = document.createElement('td');
      const banned = user.accountStatus === 'banned';
      statusCell.style.color = banned ? '#dc2626' : '#16a34a';
      statusCell.textContent = banned ? '⛔ Banned' : user.accountStatus === 'pending' ? '⏳ Pending' : '✅ Active';
      row.appendChild(statusCell);

      const loginCell = document.createElement('td');
      loginCell.style.color = '#64748b';
      loginCell.textContent = user.lastLoginAt || 'Never';
      row.appendChild(loginCell);

      const countCell = document.createElement('td');
      countCell.textContent = String(Number(user.loginCount || 0));
      row.appendChild(countCell);

      const joinedCell = document.createElement('td');
      joinedCell.style.color = '#64748b';
      joinedCell.textContent = String(user.createdAt || '').split(/[ T]/, 1)[0] || '—';
      row.appendChild(joinedCell);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'actions-cell';
      if (banned) {
        actionsCell.appendChild(actionButton('Unban', 'fa-solid fa-unlock', 'btn btn-success btn-xs', () => window.unbanUser(user.id)));
      } else {
        actionsCell.appendChild(actionButton('Ban', 'fa-solid fa-ban', 'btn btn-outline btn-xs', () => window.banUser(user.id, user.name || 'user')));
      }
      actionsCell.appendChild(actionButton('Edit', 'fa-solid fa-pen-to-square', 'btn btn-outline btn-xs', () => window.openUserModal(user.id)));
      if (user.role !== 'admin') {
        actionsCell.appendChild(actionButton('Delete', 'fa-solid fa-trash', 'btn btn-danger btn-xs', () => window.deleteUser(user.id, user.name || 'user')));
      }
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
      client.renderTableError('tableBody', 10, messageFrom(listingsResult.reason, 'Listings could not be loaded from the database.'), window.loadData);
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
      const body = await client.requestJson('/auth/admin-districts', {}, adminFetch);
      allDistricts = Array.isArray(body.data) ? body.data : [];
      window.renderDistrictsTable();
    } catch (error) {
      console.error(error);
      client.renderTableError('districtsTableBody', 6, messageFrom(error, 'Districts could not be loaded from the database.'), window.loadDistrictsData);
    }
  };

  window.loadUsersData = async function loadUsersData() {
    try {
      const body = await client.requestJson('/auth/admin-users', {}, adminFetch);
      adminUsers = Array.isArray(body.data) ? body.data : [];
      window.renderUsersTable();
    } catch (error) {
      console.error(error);
      client.renderTableError('usersTableBody', 8, messageFrom(error, 'Users could not be loaded from the database.'), window.loadUsersData);
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
