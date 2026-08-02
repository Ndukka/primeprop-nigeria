/* Narrow compatibility corrections for legacy admin controls. */
(() => {
  'use strict';

  function safeManagedMediaUrl(value) {
    return typeof value === 'string'
      && (value.startsWith('https://') || value.startsWith('/api/images/'));
  }

  // Upload responses intentionally use same-origin /api/images/... paths.
  window.isSafeUrl = safeManagedMediaUrl;

  const roleSelect = document.getElementById('userFormRole');
  const unsupportedUserRole = roleSelect?.querySelector('option[value="user"]');
  if (unsupportedUserRole) unsupportedUserRole.remove();

  const originalOpenUserModal = window.openUserModal;
  if (typeof originalOpenUserModal === 'function') {
    window.openUserModal = function openUserModal(id) {
      originalOpenUserModal(id);
      const email = document.getElementById('userFormEmail');
      if (email) {
        email.disabled = Boolean(id);
        email.title = id ? 'Email changes require the account owner.' : '';
      }
      if (!id && roleSelect) roleSelect.value = 'agent';
    };
  }

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
})();
