/* Adds a separate public-agent-profile editor to the existing admin user modal. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  if (!client) return;
  let installed = false;
  let loadedUserId = null;

  function input(id, type = 'text', maxLength = 500) {
    const element = document.createElement('input');
    element.id = id;
    element.type = type;
    element.maxLength = maxLength;
    element.autocomplete = 'off';
    return element;
  }

  function textarea(id, maxLength, rows = 3) {
    const element = document.createElement('textarea');
    element.id = id;
    element.maxLength = maxLength;
    element.rows = rows;
    return element;
  }

  function group(labelText, control, hintText = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = labelText;
    wrapper.append(label, control);
    if (hintText) {
      const hint = document.createElement('small');
      hint.textContent = hintText;
      hint.style.color = '#64748b';
      hint.style.fontSize = '.72rem';
      wrapper.appendChild(hint);
    }
    return wrapper;
  }

  function row(full = false) {
    const element = document.createElement('div');
    element.className = full ? 'form-row full' : 'form-row';
    return element;
  }

  function heading(text) {
    const element = document.createElement('h3');
    element.textContent = text;
    element.style.fontSize = '1rem';
    element.style.color = '#0f172a';
    element.style.margin = '24px 0 14px';
    element.style.paddingTop = '20px';
    element.style.borderTop = '1px solid #e2e8f0';
    return element;
  }

  function listValue(value) {
    return Array.isArray(value) ? value.join(', ') : '';
  }

  function splitList(value) {
    return String(value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean).slice(0, 20);
  }

  function value(id) {
    return document.getElementById(id)?.value?.trim() || '';
  }

  function checked(id) {
    return Boolean(document.getElementById(id)?.checked);
  }

  function install() {
    if (installed) return true;
    const form = document.getElementById('userForm');
    const footer = document.querySelector('#userModal .modal-footer');
    if (!form || !footer) return false;
    installed = true;

    const section = document.createElement('section');
    section.id = 'adminPublicProfileFields';
    section.appendChild(heading('Public agent profile'));

    const intro = document.createElement('p');
    intro.textContent = 'These fields appear on the public agent page. Login email, account status and audit information remain private.';
    intro.style.color = '#64748b';
    intro.style.fontSize = '.82rem';
    intro.style.marginBottom = '16px';
    section.appendChild(intro);

    const about = row(true);
    about.appendChild(group('About', textarea('adminProfileBio', 3000, 5)));
    section.appendChild(about);

    const organisation = row();
    organisation.append(
      group('Organisation name', input('adminProfileOrganizationName', 'text', 200)),
      group('Organisation role', input('adminProfileOrganizationRole', 'text', 160)),
    );
    section.appendChild(organisation);

    const organisationLinks = row();
    organisationLinks.append(
      group('Organisation website', input('adminProfileOrganizationWebsite', 'url', 1000), 'HTTPS only.'),
      group('Organisation logo', input('adminProfileOrganizationLogo', 'url', 1000), 'HTTPS or PrimeProp upload.'),
    );
    section.appendChild(organisationLinks);

    const address = row(true);
    address.appendChild(group('Office address', textarea('adminProfileOrganizationAddress', 500, 2)));
    section.appendChild(address);

    const practice = row();
    const years = input('adminProfileYears', 'number', 2);
    years.min = '0';
    years.max = '80';
    practice.append(
      group('Years of experience', years),
      group('Typical response time', input('adminProfileResponseTime', 'text', 120)),
    );
    section.appendChild(practice);

    const specialties = row(true);
    specialties.appendChild(group('Specialties and services', textarea('adminProfileSpecialties', 2000, 2), 'Comma-separated.'));
    section.appendChild(specialties);

    const areas = row(true);
    areas.appendChild(group('Areas served', textarea('adminProfileServiceAreas', 2000, 2), 'Comma-separated.'));
    section.appendChild(areas);

    const languageMembership = row();
    languageMembership.append(
      group('Languages', input('adminProfileLanguages', 'text', 1000), 'Comma-separated.'),
      group('Professional memberships', input('adminProfileMemberships', 'text', 2000), 'Comma-separated.'),
    );
    section.appendChild(languageMembership);

    const credentials = row();
    credentials.append(
      group('Professional body', input('adminProfileLicenseBody', 'text', 100)),
      group('Registration number', input('adminProfileLicenseNumber', 'text', 120)),
    );
    section.appendChild(credentials);

    const contact = row();
    contact.append(
      group('Public email', input('adminProfilePublicEmail', 'email', 254)),
      group('Professional website', input('adminProfileWebsite', 'url', 1000), 'HTTPS only.'),
    );
    section.appendChild(contact);

    const availability = row();
    availability.append(
      group('Office hours', input('adminProfileOfficeHours', 'text', 250)),
      group('LinkedIn', input('adminProfileLinkedIn', 'url', 1000), 'HTTPS only.'),
    );
    section.appendChild(availability);

    const social = row();
    social.appendChild(group('Instagram', input('adminProfileInstagram', 'url', 1000), 'HTTPS only.'));
    const controls = document.createElement('div');
    controls.className = 'form-group';
    for (const [id, labelText] of [
      ['adminProfilePublished', 'Publish this agent profile'],
      ['adminProfileVerified', 'Mark profile as administrator verified'],
    ]) {
      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '8px';
      label.style.textTransform = 'none';
      label.style.letterSpacing = '0';
      const checkbox = document.createElement('input');
      checkbox.id = id;
      checkbox.type = 'checkbox';
      checkbox.style.width = 'auto';
      label.append(checkbox, document.createTextNode(labelText));
      controls.appendChild(label);
    }
    social.appendChild(controls);
    section.appendChild(social);

    const status = document.createElement('p');
    status.id = 'adminProfileStatus';
    status.setAttribute('role', 'status');
    status.style.fontSize = '.82rem';
    status.style.marginTop = '12px';
    section.appendChild(status);
    form.appendChild(section);

    const save = document.createElement('button');
    save.type = 'button';
    save.id = 'adminProfileSaveButton';
    save.className = 'btn btn-success';
    save.textContent = 'Save Public Profile';
    save.addEventListener('click', saveProfile);
    footer.insertBefore(save, document.getElementById('userModalSaveBtn'));
    return true;
  }

  function setStatus(message, error = false) {
    const status = document.getElementById('adminProfileStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = error ? '#dc2626' : '#15803d';
  }

  function populate(user) {
    if (!install()) return;
    const values = {
      adminProfileBio: user.bio,
      adminProfileOrganizationName: user.organizationName,
      adminProfileOrganizationRole: user.organizationRole,
      adminProfileOrganizationWebsite: user.organizationWebsite,
      adminProfileOrganizationAddress: user.organizationAddress,
      adminProfileOrganizationLogo: user.organizationLogoUrl,
      adminProfilePublicEmail: user.publicEmail,
      adminProfileWebsite: user.websiteUrl,
      adminProfileServiceAreas: listValue(user.serviceAreas),
      adminProfileSpecialties: listValue(user.specialties),
      adminProfileLanguages: listValue(user.languages),
      adminProfileMemberships: listValue(user.professionalMemberships),
      adminProfileYears: String(user.yearsExperience || 0),
      adminProfileLicenseBody: user.licenseBody,
      adminProfileLicenseNumber: user.licenseNumber,
      adminProfileResponseTime: user.responseTime,
      adminProfileOfficeHours: user.officeHours,
      adminProfileLinkedIn: user.linkedinUrl,
      adminProfileInstagram: user.instagramUrl,
    };
    for (const [id, fieldValue] of Object.entries(values)) {
      const element = document.getElementById(id);
      if (element) element.value = fieldValue || '';
    }
    document.getElementById('adminProfilePublished').checked = user.profilePublished !== false;
    document.getElementById('adminProfileVerified').checked = Boolean(user.profileVerified);

    const section = document.getElementById('adminPublicProfileFields');
    const button = document.getElementById('adminProfileSaveButton');
    const isAgent = user.role === 'agent';
    if (section) section.hidden = !isAgent;
    if (button) button.hidden = !isAgent;
    setStatus('');
  }

  async function loadUser(id) {
    if (!id || id === loadedUserId) return;
    loadedUserId = id;
    try {
      const body = await client.requestJson(`/auth/admin-users/${encodeURIComponent(id)}`, {}, window.apiFetch);
      populate(body.data || {});
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Public profile could not be loaded.', true);
    }
  }

  async function saveProfile() {
    const id = Number(document.getElementById('userFormId')?.value || 0);
    const button = document.getElementById('adminProfileSaveButton');
    if (!id || button?.disabled) return;
    if (button) button.disabled = true;
    setStatus('Saving public profile…');

    try {
      const body = await client.requestJson(`/auth/admin-profile-settings/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: value('userFormName'),
          phone: value('userFormPhone'),
          avatar_url: value('userFormAvatar'),
          bio: value('adminProfileBio'),
          organization_name: value('adminProfileOrganizationName'),
          organization_role: value('adminProfileOrganizationRole'),
          organization_website: value('adminProfileOrganizationWebsite'),
          organization_address: value('adminProfileOrganizationAddress'),
          organization_logo_url: value('adminProfileOrganizationLogo'),
          public_email: value('adminProfilePublicEmail'),
          website_url: value('adminProfileWebsite'),
          service_areas: splitList(value('adminProfileServiceAreas')),
          specialties: splitList(value('adminProfileSpecialties')),
          languages: splitList(value('adminProfileLanguages')),
          professional_memberships: splitList(value('adminProfileMemberships')),
          years_experience: Number(value('adminProfileYears') || 0),
          license_body: value('adminProfileLicenseBody'),
          license_number: value('adminProfileLicenseNumber'),
          response_time: value('adminProfileResponseTime'),
          office_hours: value('adminProfileOfficeHours'),
          linkedin_url: value('adminProfileLinkedIn'),
          instagram_url: value('adminProfileInstagram'),
          profile_published: checked('adminProfilePublished'),
          profile_verified: checked('adminProfileVerified'),
        }),
      }, window.apiFetch);
      setStatus('Public agent profile saved.');
      if (typeof window.loadUsersData === 'function') await window.loadUsersData();
      populate({
        ...(body.data || {}),
        role: 'agent',
        organizationName: body.data?.organization_name,
        organizationRole: body.data?.organization_role,
        organizationWebsite: body.data?.organization_website,
        organizationAddress: body.data?.organization_address,
        organizationLogoUrl: body.data?.organization_logo_url,
        publicEmail: body.data?.public_email,
        websiteUrl: body.data?.website_url,
        serviceAreas: body.data?.service_areas,
        specialties: body.data?.specialties,
        languages: body.data?.languages,
        professionalMemberships: body.data?.professional_memberships,
        yearsExperience: body.data?.years_experience,
        licenseBody: body.data?.license_body,
        licenseNumber: body.data?.license_number,
        responseTime: body.data?.response_time,
        officeHours: body.data?.office_hours,
        linkedinUrl: body.data?.linkedin_url,
        instagramUrl: body.data?.instagram_url,
        profileVerified: body.data?.profile_verified,
        profilePublished: body.data?.profile_published,
      });
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Public profile could not be saved.', true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function watchModal() {
    if (!install()) return;
    const modal = document.getElementById('userModal');
    if (!modal?.classList.contains('active')) {
      loadedUserId = null;
      return;
    }
    const id = Number(document.getElementById('userFormId')?.value || 0);
    if (id) loadUser(id);
  }

  const observer = new MutationObserver(watchModal);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'value'] });
  document.addEventListener('click', event => {
    if (event.target.closest('#userModal, [title="Edit"]')) setTimeout(watchModal, 0);
  });
  watchModal();
})();
