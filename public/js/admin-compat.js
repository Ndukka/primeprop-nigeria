/* Narrow compatibility corrections for legacy admin controls. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  const originalRenderTable = window.renderTable;
  const originalLoadData = window.loadData;

  function safeManagedMediaUrl(value) {
    return typeof value === 'string'
      && (value.startsWith('https://') || value.startsWith('/api/images/'));
  }

  // Upload responses intentionally use same-origin /api/images/... paths.
  window.isSafeUrl = safeManagedMediaUrl;

  function setRuntimeDisplay(element, display) {
    if (!element) return;
    if (window.PrimePropStyles && typeof window.PrimePropStyles.set === 'function') {
      window.PrimePropStyles.set(element, 'display', display);
      return;
    }
    element.hidden = display === 'none';
  }

  function configureAddButton(button, label, handler) {
    if (!button) return;
    window.clearContainer(button);
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-plus';
    button.append(icon, document.createTextNode(` ${label}`));
    if (window.PrimePropEvents && typeof window.PrimePropEvents.replace === 'function') {
      window.PrimePropEvents.replace(button, 'click', handler);
    } else {
      button.addEventListener('click', handler, { once: true });
    }
  }

  // The strict public build converts the source display:none attributes on the
  // Districts and Users wrappers into permanent generated CSS classes. Setting
  // display to an empty string cannot override those classes. Use explicit
  // runtime display values so the selected table is always visible.
  window.switchTab = function switchTab(tab) {
    const selected = ['listings', 'districts', 'users'].includes(tab) ? tab : 'listings';
    activeTab = selected;

    const tabListings = document.getElementById('tabListings');
    const tabDistricts = document.getElementById('tabDistricts');
    const tabUsers = document.getElementById('tabUsers');
    const listingsTableWrap = document.getElementById('listingsTableWrap');
    const districtsTableWrap = document.getElementById('districtsTableWrap');
    const usersTableWrap = document.getElementById('usersTableWrap');
    const listingsToolbar = document.getElementById('listingsToolbar');
    const addButton = document.getElementById('addButton');

    for (const button of [tabListings, tabDistricts, tabUsers]) {
      if (!button) continue;
      button.classList.remove('tab-active');
      button.classList.add('btn-outline');
    }

    const activeButton = selected === 'districts'
      ? tabDistricts
      : selected === 'users'
        ? tabUsers
        : tabListings;
    activeButton?.classList.add('tab-active');
    activeButton?.classList.remove('btn-outline');

    setRuntimeDisplay(listingsTableWrap, selected === 'listings' ? 'block' : 'none');
    setRuntimeDisplay(districtsTableWrap, selected === 'districts' ? 'block' : 'none');
    setRuntimeDisplay(usersTableWrap, selected === 'users' ? 'block' : 'none');
    setRuntimeDisplay(listingsToolbar, selected === 'listings' ? 'flex' : 'none');

    if (selected === 'districts') {
      configureAddButton(addButton, 'Add District', window.openDistrictModal);
      window.loadDistrictsData();
      return;
    }
    if (selected === 'users') {
      configureAddButton(addButton, 'Add User', window.openUserModal);
      window.loadUsersData();
      return;
    }
    configureAddButton(addButton, 'Add Listing', window.openAddModal);
  };

  function visibleAdminListings() {
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

  function approvalBadge(status) {
    const badge = document.createElement('span');
    const approved = status === 'approved';
    badge.className = `badge ${approved ? 'badge-land' : 'badge-featured'}`;
    badge.textContent = approved ? 'Approved · Live' : 'Pending approval';
    badge.style.marginTop = '4px';
    return badge;
  }

  function approvalButton(listing) {
    const approved = listing.approvalStatus === 'approved';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = approved ? 'btn btn-outline btn-xs' : 'btn btn-success btn-xs';
    button.title = approved ? 'Remove from public listings' : 'Approve and publish';
    const icon = document.createElement('i');
    icon.className = approved ? 'fa-solid fa-eye-slash' : 'fa-solid fa-circle-check';
    button.appendChild(icon);
    button.addEventListener('click', () => {
      if (approved && !window.confirm(`Remove "${listing.title || 'this listing'}" from the public catalogue?`)) return;
      void setListingApproval(listing.id, approved ? 'pending' : 'approved');
    });
    return button;
  }

  async function setListingApproval(id, approvalStatus) {
    window.showLoading(true);
    try {
      const body = await client.requestJson(`/auth/admin-listings/${encodeURIComponent(id)}/approval`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalStatus }),
      }, window.apiFetch);
      window.showToast(body.message || 'Listing approval updated.', 'success');
      await window.loadData();
    } catch (error) {
      console.error(error);
      window.showToast(error.message || 'Listing approval could not be updated.', 'error');
    } finally {
      window.showLoading(false);
    }
  }

  if (typeof originalRenderTable === 'function') {
    window.renderTable = function renderTableWithApproval() {
      originalRenderTable();
      const rows = visibleAdminListings();
      const renderedRows = Array.from(document.querySelectorAll('#tableBody > tr'));
      if (renderedRows.length !== rows.length) return;

      renderedRows.forEach((row, index) => {
        const listing = rows[index];
        const titleCell = row.cells[1];
        const actionsCell = row.cells[9]?.querySelector('.actions-cell');
        if (titleCell) titleCell.append(document.createElement('br'), approvalBadge(listing.approvalStatus));
        if (actionsCell) actionsCell.prepend(approvalButton(listing));
      });
    };
  }

  function updateInventoryStats() {
    if (!Array.isArray(allListings)) return;
    const values = {
      statTotal: allListings.length,
      statRent: allListings.filter(listing => listing.type === 'rent').length,
      statSale: allListings.filter(listing => listing.type === 'sale').length,
      statLand: allListings.filter(listing => listing.type === 'land').length,
      statFeatured: allListings.filter(listing => listing.featured).length,
    };
    for (const [id, value] of Object.entries(values)) {
      const element = document.getElementById(id);
      if (element) element.textContent = String(value);
    }
  }

  if (typeof originalLoadData === 'function') {
    window.loadData = async function loadDataWithInventoryStats() {
      await originalLoadData();
      updateInventoryStats();
    };
  }

  const roleSelect = document.getElementById('userFormRole');
  const unsupportedUserRole = roleSelect?.querySelector('option[value="user"]');
  if (unsupportedUserRole) unsupportedUserRole.remove();

  window.openUserModal = function openUserModal(id) {
    userEditId = id || null;
    document.getElementById('userModalTitle').textContent = id ? 'Edit User' : 'Add User';
    document.getElementById('userModalSaveBtn').textContent = id ? 'Update User' : 'Create User';

    const email = document.getElementById('userFormEmail');
    email.disabled = Boolean(id);
    email.title = id ? 'Email changes require the account owner.' : '';

    if (!id) {
      window.resetUserForm();
      if (roleSelect) roleSelect.value = 'agent';
      document.getElementById('userModal').classList.add('active');
      return;
    }

    client.requestJson(`/auth/admin-users/${encodeURIComponent(id)}`, {}, window.apiFetch)
      .then(body => {
        const user = body.data;
        document.getElementById('userFormId').value = String(user.id);
        document.getElementById('userFormName').value = user.name || '';
        email.value = user.email || '';
        if (roleSelect) roleSelect.value = user.role === 'admin' ? 'admin' : 'agent';
        document.getElementById('userFormPhone').value = user.phone || '';
        document.getElementById('userFormAvatar').value = user.avatarUrl || '';
        document.getElementById('userFormPassword').value = '';

        const preview = document.getElementById('userAvatarUploadPreview');
        if (preview) {
          window.clearContainer(preview);
          if (safeManagedMediaUrl(user.avatarUrl)) {
            preview.appendChild(window.createPreviewItem(user.avatarUrl, () => {
              document.getElementById('userFormAvatar').value = '';
            }));
          }
        }
      })
      .catch(error => {
        console.error(error);
        window.showToast(error.message || 'The user could not be loaded.', 'error');
      });

    document.getElementById('userModal').classList.add('active');
  };

  const originalResetUserForm = window.resetUserForm;
  if (typeof originalResetUserForm === 'function') {
    window.resetUserForm = function resetUserForm() {
      originalResetUserForm();
      const email = document.getElementById('userFormEmail');
      if (email) {
        email.disabled = false;
        email.title = '';
      }
      if (roleSelect) roleSelect.value = 'agent';
    };
  }

  async function setAccountStatus(id, accountStatus, successMessage) {
    if (!client) throw new Error('PrimePropClient is unavailable.');
    window.showLoading(true);
    try {
      await client.requestJson(`/auth/users/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_status: accountStatus }),
      }, window.apiFetch);
      window.showToast(successMessage, 'success');
      await window.loadUsersData();
    } catch (error) {
      console.error(error);
      window.showToast(error.message || 'The account status could not be changed.', 'error');
    } finally {
      window.showLoading(false);
    }
  }

  window.banUser = function banUser(id, name) {
    if (!window.confirm(`Ban user "${name}"? They will not be able to log in.`)) return;
    return setAccountStatus(id, 'banned', 'User banned.');
  };

  window.unbanUser = function unbanUser(id) {
    return setAccountStatus(id, 'active', 'User unbanned.');
  };

  window.switchTab(typeof activeTab === 'string' ? activeTab : 'listings');
})();
