/* Narrow compatibility corrections for legacy admin controls. */
(() => {
  'use strict';

  const client = window.PrimePropClient;

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