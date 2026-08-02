/* PrimeProp agent dashboard data, profile, and permission corrections. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  if (!client) throw new Error('PrimePropClient must load before the agent dashboard.');

  const originalApiFetch = window.apiFetch;
  const originalRenderTable = window.renderTable;
  const originalShowToast = window.showToast;
  let currentProfile = null;

  function safeMediaUrl(value) {
    return typeof value === 'string' && (value.startsWith('https://') || value.startsWith('/api/images/'));
  }

  // The upload API intentionally returns same-origin /api/images/... URLs.
  // Keep the legacy dashboard helpers strict while allowing those managed files.
  window.isSafeUrl = safeMediaUrl;

  function roleAwareListingUrl(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'POST' && url === '/api/listings') return '/auth/listing-records';
    if (['PUT', 'DELETE'].includes(method) && /^\/api\/listings\/\d+$/.test(url)) {
      return url.replace('/api/listings/', '/auth/listing-records/');
    }
    return url;
  }

  window.apiFetch = function apiFetch(url, options = {}) {
    return originalApiFetch(roleAwareListingUrl(url, options), options);
  };

  function agentFetch(url, options) {
    return window.apiFetch(url, options);
  }

  function normalizeListing(listing) {
    return {
      ...listing,
      property_type: listing.property_type || listing.propertyType || 'apartment',
      price_unit: listing.price_unit || listing.priceUnit || '',
      approval_status: listing.approval_status || listing.approvalStatus || 'pending',
    };
  }

  function decorateApprovalStatuses() {
    const rows = Array.from(document.querySelectorAll('#tableBody > tr'));
    if (rows.length !== myListings.length) return;
    rows.forEach((row, index) => {
      const listing = myListings[index];
      const cell = row.cells[5];
      if (!cell) return;
      const approved = listing.approval_status === 'approved';
      cell.textContent = approved ? '✓ Approved · Live' : '⏳ Pending admin approval';
      cell.style.color = approved ? '#15803d' : '#b45309';
      cell.style.fontWeight = '600';
    });
  }

  if (typeof originalRenderTable === 'function') {
    window.renderTable = function renderTableWithApproval() {
      originalRenderTable();
      decorateApprovalStatuses();
    };
  }

  if (typeof originalShowToast === 'function') {
    window.showToast = function showApprovalAwareToast(message, type = '') {
      let text = message;
      if (message === 'Listing created!') {
        text = 'Listing submitted for administrator approval.';
      } else if (message === 'Listing updated!') {
        text = 'Listing updated and returned for administrator approval.';
      }
      return originalShowToast(text, type);
    };
  }

  function fieldGroup(labelText, input) {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = labelText;
    group.append(label, input);
    return group;
  }

  function textInput(id, type = 'text') {
    const input = document.createElement('input');
    input.id = id;
    input.type = type;
    input.autocomplete = 'off';
    return input;
  }

  function createProfileModal() {
    if (document.getElementById('agentProfileModal')) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'agentProfileModal';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const heading = document.createElement('h2');
    heading.textContent = 'Listing Profile';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'modal-close';
    closeButton.setAttribute('aria-label', 'Close profile');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', closeProfileModal);
    header.append(heading, closeButton);

    const body = document.createElement('div');
    body.className = 'modal-body';
    const guidance = document.createElement('p');
    guidance.textContent = 'These details are saved to your account and used automatically on every listing you create.';
    guidance.style.color = '#64748b';
    guidance.style.fontSize = '.85rem';
    guidance.style.marginBottom = '16px';

    const form = document.createElement('form');
    form.id = 'agentProfileForm';
    form.addEventListener('submit', event => {
      event.preventDefault();
      saveProfile();
    });

    const firstRow = document.createElement('div');
    firstRow.className = 'form-row';
    const nameInput = textInput('profileName');
    nameInput.required = true;
    nameInput.maxLength = 200;
    const phoneInput = textInput('profilePhone', 'tel');
    phoneInput.maxLength = 50;
    phoneInput.placeholder = '2348012345678';
    firstRow.append(fieldGroup('Agent Name', nameInput), fieldGroup('Phone (WhatsApp)', phoneInput));

    const secondRow = document.createElement('div');
    secondRow.className = 'form-row';
    const titleInput = textInput('profileAgentTitle');
    titleInput.maxLength = 120;
    titleInput.placeholder = 'Listing Agent — Lagos';
    const avatarInput = textInput('profileAvatar');
    avatarInput.maxLength = 1000;
    avatarInput.placeholder = 'https://… or uploaded image';
    secondRow.append(fieldGroup('Agent Role / Title', titleInput), fieldGroup('Profile Picture', avatarInput));

    const uploadRow = document.createElement('div');
    uploadRow.className = 'form-row full';
    const uploadGroup = document.createElement('div');
    uploadGroup.className = 'form-group';
    const uploadLabel = document.createElement('label');
    uploadLabel.textContent = 'Upload Profile Picture';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'profileAvatarFile';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    const uploadButton = document.createElement('button');
    uploadButton.type = 'button';
    uploadButton.className = 'btn btn-outline';
    uploadButton.textContent = 'Choose image';
    uploadButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', uploadProfileAvatar);
    uploadGroup.append(uploadLabel, uploadButton, fileInput);
    uploadRow.appendChild(uploadGroup);

    const status = document.createElement('p');
    status.id = 'profileStatus';
    status.setAttribute('role', 'status');
    status.style.fontSize = '.82rem';
    status.style.marginTop = '8px';

    form.append(firstRow, secondRow, uploadRow, status);
    body.append(guidance, form);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-outline';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeProfileModal);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.id = 'profileSaveButton';
    save.textContent = 'Save Profile';
    save.addEventListener('click', () => form.requestSubmit());
    footer.append(cancel, save);

    modal.append(header, body, footer);
    overlay.appendChild(modal);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeProfileModal();
    });
    document.body.appendChild(overlay);
  }

  function addProfileButton() {
    const actionRow = document.querySelector('.agent-header > div:last-child');
    if (!actionRow || document.getElementById('editProfileButton')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'editProfileButton';
    button.className = 'btn btn-sm btn-outline';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-user-pen';
    button.append(icon, document.createTextNode(' Edit Profile'));
    button.addEventListener('click', openProfileModal);
    const firstLink = actionRow.querySelector('a');
    actionRow.insertBefore(button, firstLink || actionRow.firstChild);
  }

  function setProfileStatus(message, isError = false) {
    const status = document.getElementById('profileStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#dc2626' : '#15803d';
  }

  function populateProfileForm() {
    if (!currentProfile) return;
    document.getElementById('profileName').value = currentProfile.name || '';
    document.getElementById('profilePhone').value = currentProfile.phone || '';
    document.getElementById('profileAgentTitle').value = currentProfile.agent_title || 'Listing Agent';
    document.getElementById('profileAvatar').value = currentProfile.avatar_url || '';
    setProfileStatus('');
  }

  function openProfileModal() {
    createProfileModal();
    populateProfileForm();
    document.getElementById('agentProfileModal').classList.add('active');
  }

  function closeProfileModal() {
    document.getElementById('agentProfileModal')?.classList.remove('active');
  }

  async function loadProfile() {
    const body = await client.requestJson('/auth/profile-settings', {}, agentFetch);
    currentProfile = body.data || null;
    if (currentProfile) {
      USER = { ...USER, ...currentProfile };
      const nameElement = document.getElementById('agentName');
      if (nameElement) nameElement.textContent = currentProfile.name || USER.name;
    }
    return currentProfile;
  }

  async function saveProfile() {
    const saveButton = document.getElementById('profileSaveButton');
    if (saveButton?.disabled) return;
    if (saveButton) saveButton.disabled = true;
    setProfileStatus('Saving…');
    try {
      const body = await client.requestJson('/auth/profile-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('profileName').value.trim(),
          phone: document.getElementById('profilePhone').value.trim(),
          agent_title: document.getElementById('profileAgentTitle').value.trim(),
          avatar_url: document.getElementById('profileAvatar').value.trim(),
        }),
      }, agentFetch);
      currentProfile = body.data;
      USER = { ...USER, ...currentProfile };
      document.getElementById('agentName').textContent = currentProfile.name || USER.name;
      setProfileStatus('Profile saved. Affected listings require administrator approval again.');
      await window.loadData();
    } catch (error) {
      console.error(error);
      setProfileStatus(error.message || 'Profile could not be saved.', true);
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  }

  async function uploadProfileAvatar(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setProfileStatus('Uploading image…');
    try {
      const formData = new FormData();
      formData.append('files', file);
      const body = await client.requestJson('/api/images/upload', {
        method: 'POST',
        body: formData,
      }, agentFetch);
      const uploaded = Array.isArray(body.data) ? body.data.find(item => item.url && !item.error) : null;
      if (!uploaded) throw new Error('The image was not accepted.');
      document.getElementById('profileAvatar').value = uploaded.url;
      setProfileStatus('Image uploaded. Save the profile to apply it.');
    } catch (error) {
      console.error(error);
      setProfileStatus(error.message || 'Image upload failed.', true);
    } finally {
      event.target.value = '';
    }
  }

  function removeAgentListingOverrides() {
    const managedIds = [
      'formAgentPhone',
      'formAgentAvatar',
      'formBadge',
      'formFeatured',
      'formVerified',
    ];
    for (const id of managedIds) {
      const control = document.getElementById(id);
      if (!control) continue;
      control.disabled = true;
      const group = control.closest('.form-group');
      if (group) group.hidden = true;
    }
  }

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
      window.renderTable();
      document.getElementById('statTotal').textContent = String(myListings.length);
      document.getElementById('statFeatured').textContent = String(myListings.filter(listing => listing.featured).length);
      document.getElementById('statVerified').textContent = String(myListings.filter(listing => listing.verified).length);
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
    }
  };

  async function initializeAgentPage() {
    addServiceApartmentOption();
    removeAgentListingOverrides();
    createProfileModal();
    addProfileButton();
    await Promise.all([loadProfile(), window.loadData()]);
  }

  function refreshAfterAuthenticatedBootstrap(attempt = 0) {
    if (USER) {
      if (USER.role === 'admin') {
        window.location.replace('/admin');
        return;
      }
      initializeAgentPage().catch(error => {
        console.error(error);
        client.renderTableError('tableBody', 7, error.message || 'The dashboard could not be initialized.', () => window.location.reload());
      });
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
