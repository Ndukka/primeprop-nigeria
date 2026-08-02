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
})();
