/* Narrow compatibility corrections for legacy admin controls. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  const originalRenderTable = window.renderTable;
  const originalLoadData = window.loadData;
  let ownerStatusById = new Map();

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

  function actionButton(title, iconClass, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    const icon = document.createElement('i');
    icon.className = iconClass;
    button.appendChild(icon);
    if (handler) button.addEventListener('click', handler);
    return button;
  }

  function tableHeading(text) {
    const heading = document.createElement('th');
    heading.textContent = text;
    return heading;
  }

  function createApprovalInterface() {
    if (document.getElementById('tabApprovals')) return;
    const listingsTab = document.getElementById('tabListings');
    const tabRow = listingsTab?.parentElement;
    const listingsWrap = document.getElementById('listingsTableWrap');
    if (!listingsTab || !tabRow || !listingsWrap?.parentElement) return;

    const approvalsTab = document.createElement('button');
    approvalsTab.type = 'button';
    approvalsTab.id = 'tabApprovals';
    approvalsTab.className = 'btn btn-sm tab-btn btn-outline';
    approvalsTab.style.borderRadius = '8px';
    approvalsTab.append(document.createTextNode('🕒 Approvals '));
    const count = document.createElement('span');
    count.id = 'approvalRequestCount';
    count.textContent = '0';
    approvalsTab.appendChild(count);
    approvalsTab.addEventListener('click', () => window.switchTab('approvals'));
    listingsTab.insertAdjacentElement('afterend', approvalsTab);

    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.id = 'approvalsTableWrap';
    wrap.hidden = true;

    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headingRow = document.createElement('tr');
    for (const label of ['Image', 'Listing', 'Agent', 'Type', 'Price', 'Location', 'Submitted', 'Owner status', 'Actions']) {
      headingRow.appendChild(tableHeading(label));
    }
    head.appendChild(headingRow);

    const body = document.createElement('tbody');
    body.id = 'approvalsTableBody';
    table.append(head, body);
    wrap.appendChild(table);
    listingsWrap.insertAdjacentElement('afterend', wrap);
  }

  function listingOwnerStatus(listing) {
    if (listing.createdBy == null) return 'active';
    return ownerStatusById.get(Number(listing.createdBy)) || 'unknown';
  }

  function updateApprovalCount() {
    const count = Array.isArray(allListings)
      ? allListings.filter(listing => listing.approvalStatus !== 'approved').length
      : 0;
    const element = document.getElementById('approvalRequestCount');
    if (element) element.textContent = String(count);
  }

  function emptyApprovals(text) {
    const body = document.getElementById('approvalsTableBody');
    if (!body) return;
    window.clearContainer(body);
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 9;
    cell.className = 'empty-state-admin';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-clipboard-check';
    const message = document.createElement('p');
    message.textContent = text;
    cell.append(icon, message);
    row.appendChild(cell);
    body.appendChild(row);
  }

  function moderationBadge(text, kind) {
    const badge = document.createElement('span');
    badge.className = `badge ${kind === 'active' ? 'badge-land' : kind === 'pending' ? 'badge-featured' : 'badge-sale'}`;
    badge.textContent = text;
    return badge;
  }

  function approvalButton(listing, showText = false) {
    const approved = listing.approvalStatus === 'approved';
    const ownerStatus = listingOwnerStatus(listing);
    const button = actionButton(
      approved ? 'Remove from public listings' : 'Approve and publish',
      approved ? 'fa-solid fa-eye-slash' : 'fa-solid fa-circle-check',
      approved ? 'btn btn-outline btn-xs' : 'btn btn-success btn-xs',
      () => {
        if (approved && !window.confirm(`Remove "${listing.title || 'this listing'}" from the public catalogue?`)) return;
        void setListingApproval(listing.id, approved ? 'pending' : 'approved');
      },
    );

    if (!approved && ownerStatus !== 'active') {
      button.disabled = true;
      button.className = 'btn btn-outline btn-xs';
      button.title = ownerStatus === 'unknown'
        ? 'Owner status is still loading.'
        : 'Unban this listing owner before approval.';
    }
    if (showText) {
      button.appendChild(document.createTextNode(approved ? ' Pause' : ' Approve'));
    }
    return button;
  }

  function renderApprovalsTable() {
    const body = document.getElementById('approvalsTableBody');
    if (!body) return;
    const pending = (Array.isArray(allListings) ? allListings : [])
      .filter(listing => listing.approvalStatus !== 'approved')
      .sort((left, right) => Number(right.id || 0) - Number(left.id || 0));
    updateApprovalCount();
    window.clearContainer(body);

    if (pending.length === 0) {
      emptyApprovals('No new listing requests are awaiting approval.');
      return;
    }

    for (const listing of pending) {
      const row = document.createElement('tr');
      const firstImage = Array.isArray(listing.images) && listing.images.length > 0 ? listing.images[0] : null;
      const imageUrl = typeof firstImage === 'string' ? firstImage : firstImage?.url;

      const imageCell = document.createElement('td');
      if (safeManagedMediaUrl(imageUrl)) {
        const image = document.createElement('img');
        image.src = imageUrl;
        image.alt = listing.title || '';
        image.className = 'td-img';
        image.addEventListener('error', () => image.remove());
        imageCell.appendChild(image);
      } else imageCell.textContent = '—';
      row.appendChild(imageCell);

      const listingCell = document.createElement('td');
      listingCell.className = 'td-title';
      listingCell.textContent = listing.title || 'Untitled listing';
      listingCell.append(document.createElement('br'), moderationBadge('Pending approval', 'pending'));
      row.appendChild(listingCell);

      const agentCell = document.createElement('td');
      agentCell.textContent = listing.agent?.name || 'Unknown agent';
      row.appendChild(agentCell);

      const typeCell = document.createElement('td');
      typeCell.appendChild(moderationBadge(
        listing.type === 'sale' ? 'For Sale' : listing.type === 'land' ? 'Land' : 'For Rent',
        'active',
      ));
      row.appendChild(typeCell);

      const priceCell = document.createElement('td');
      priceCell.style.fontWeight = '600';
      priceCell.style.whiteSpace = 'nowrap';
      priceCell.textContent = `₦${Number(listing.price || 0).toLocaleString()}${listing.priceUnit || ''}`;
      row.appendChild(priceCell);

      const locationCell = document.createElement('td');
      locationCell.textContent = listing.location || '—';
      row.appendChild(locationCell);

      const submittedCell = document.createElement('td');
      submittedCell.textContent = String(listing.createdAt || '').split(/[ T]/, 1)[0] || '—';
      row.appendChild(submittedCell);

      const statusCell = document.createElement('td');
      const ownerStatus = listingOwnerStatus(listing);
      if (ownerStatus === 'active') statusCell.appendChild(moderationBadge('Active', 'active'));
      else if (ownerStatus === 'unknown') statusCell.appendChild(moderationBadge('Checking…', 'unknown'));
      else statusCell.appendChild(moderationBadge('Banned · paused', 'inactive'));
      row.appendChild(statusCell);

      const actionsCell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'actions-cell';
      actions.append(
        approvalButton(listing, true),
        actionButton('Review listing', 'fa-solid fa-pen-to-square', 'btn btn-outline btn-xs', () => window.openEditModal(listing.id)),
        actionButton('Delete request', 'fa-solid fa-trash', 'btn btn-danger btn-xs', () => window.confirmDelete(listing.id, listing.title || 'listing')),
      );
      actionsCell.appendChild(actions);
      row.appendChild(actionsCell);
      body.appendChild(row);
    }
  }

  async function loadOwnerStatuses() {
    if (!client) return;
    try {
      const body = await client.requestJson('/auth/admin-users', {}, window.apiFetch);
      const users = Array.isArray(body.data) ? body.data : [];
      ownerStatusById = new Map(users.map(user => [Number(user.id), String(user.accountStatus || 'active')]));
      if (activeTab === 'approvals') renderApprovalsTable();
      if (activeTab === 'listings' && typeof window.renderTable === 'function') window.renderTable();
    } catch (error) {
      console.error(error);
      ownerStatusById = new Map();
      if (activeTab === 'approvals') renderApprovalsTable();
    }
  }

  createApprovalInterface();

  // The strict public build converts source display:none attributes into
  // generated classes. Explicit runtime values keep every selected panel
  // visible without changing the existing dashboard layout.
  window.switchTab = function switchTab(tab) {
    const selected = ['listings', 'approvals', 'districts', 'users'].includes(tab) ? tab : 'listings';
    activeTab = selected;

    const tabListings = document.getElementById('tabListings');
    const tabApprovals = document.getElementById('tabApprovals');
    const tabDistricts = document.getElementById('tabDistricts');
    const tabUsers = document.getElementById('tabUsers');
    const listingsTableWrap = document.getElementById('listingsTableWrap');
    const approvalsTableWrap = document.getElementById('approvalsTableWrap');
    const districtsTableWrap = document.getElementById('districtsTableWrap');
    const usersTableWrap = document.getElementById('usersTableWrap');
    const listingsToolbar = document.getElementById('listingsToolbar');
    const addButton = document.getElementById('addButton');

    for (const button of [tabListings, tabApprovals, tabDistricts, tabUsers]) {
      if (!button) continue;
      button.classList.remove('tab-active');
      button.classList.add('btn-outline');
    }

    const activeButton = selected === 'approvals'
      ? tabApprovals
      : selected === 'districts'
        ? tabDistricts
        : selected === 'users'
          ? tabUsers
          : tabListings;
    activeButton?.classList.add('tab-active');
    activeButton?.classList.remove('btn-outline');

    setRuntimeDisplay(listingsTableWrap, selected === 'listings' ? 'block' : 'none');
    setRuntimeDisplay(approvalsTableWrap, selected === 'approvals' ? 'block' : 'none');
    setRuntimeDisplay(districtsTableWrap, selected === 'districts' ? 'block' : 'none');
    setRuntimeDisplay(usersTableWrap, selected === 'users' ? 'block' : 'none');
    setRuntimeDisplay(listingsToolbar, selected === 'listings' ? 'flex' : 'none');
    setRuntimeDisplay(addButton, selected === 'approvals' ? 'none' : 'inline-flex');

    if (selected === 'approvals') {
      renderApprovalsTable();
      void loadOwnerStatuses();
      return;
    }
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

  function ownerPauseBadge(listing) {
    if (listingOwnerStatus(listing) === 'active') return null;
    const badge = document.createElement('span');
    badge.className = 'badge badge-sale';
    badge.textContent = listingOwnerStatus(listing) === 'unknown' ? 'Checking owner…' : 'Paused · owner banned';
    badge.style.marginTop = '4px';
    return badge;
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
      if (activeTab === 'approvals') renderApprovalsTable();
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
        if (titleCell) {
          titleCell.append(document.createElement('br'), approvalBadge(listing.approvalStatus));
          const pauseBadge = ownerPauseBadge(listing);
          if (pauseBadge) titleCell.append(document.createElement('br'), pauseBadge);
        }
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
    updateApprovalCount();
  }

  if (typeof originalLoadData === 'function') {
    window.loadData = async function loadDataWithInventoryStats() {
      await originalLoadData();
      updateInventoryStats();
      if (activeTab === 'approvals') renderApprovalsTable();
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
      await Promise.all([
        window.loadUsersData(),
        window.loadData(),
        loadOwnerStatuses(),
      ]);
      if (activeTab === 'approvals') renderApprovalsTable();
    } catch (error) {
      console.error(error);
      window.showToast(error.message || 'The account status could not be changed.', 'error');
    } finally {
      window.showLoading(false);
    }
  }

  window.banUser = function banUser(id, name) {
    if (Number(AUTH_USER?.id) === Number(id)) {
      window.showToast('You cannot ban your own administrator account.', 'error');
      return;
    }
    if (!window.confirm(`Ban user "${name}"? Their sessions will be blocked and every listing they own will be hidden until unbanned.`)) return;
    return setAccountStatus(
      id,
      'banned',
      'User banned. Their sessions are blocked and their listings are paused.',
    );
  };

  window.unbanUser = function unbanUser(id) {
    return setAccountStatus(
      id,
      'active',
      'User unbanned. Previously approved listings are visible again.',
    );
  };

  void loadOwnerStatuses();
  window.switchTab(typeof activeTab === 'string' ? activeTab : 'listings');
})();
