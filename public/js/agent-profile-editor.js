/* Rich public-profile fields for the existing PrimeProp agent profile modal. */
(() => {
  'use strict';

  const client = window.PrimePropClient;
  if (!client) return;
  let installed = false;
  let profile = null;

  function fieldGroup(labelText, input, hintText = '') {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = labelText;
    group.appendChild(label);
    group.appendChild(input);
    if (hintText) {
      const hint = document.createElement('small');
      hint.textContent = hintText;
      hint.className = 'profile-field-hint';
      group.appendChild(hint);
    }
    return group;
  }

  function input(id, type = 'text', maxLength = 500) {
    const element = document.createElement('input');
    element.id = id;
    element.type = type;
    element.maxLength = maxLength;
    element.autocomplete = 'off';
    return element;
  }

  function textarea(id, maxLength, rows = 4) {
    const element = document.createElement('textarea');
    element.id = id;
    element.maxLength = maxLength;
    element.rows = rows;
    return element;
  }

  function row(className = 'form-row') {
    const element = document.createElement('div');
    element.className = className;
    return element;
  }

  function heading(text) {
    const element = document.createElement('div');
    element.className = 'profile-editor-section-heading';
    element.textContent = text;
    return element;
  }

  function listValue(value) {
    return Array.isArray(value) ? value.join(', ') : '';
  }

  function splitList(value) {
    return String(value || '')
      .split(/[\n,]/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  function value(id) {
    return document.getElementById(id)?.value?.trim() || '';
  }

  function checked(id) {
    return Boolean(document.getElementById(id)?.checked);
  }

  function installFields() {
    if (installed) return true;
    const form = document.getElementById('agentProfileForm');
    const status = document.getElementById('profileStatus');
    if (!form || !status) return false;
    installed = true;

    const fragment = document.createDocumentFragment();
    fragment.appendChild(heading('Public profile'));

    const aboutRow = row('form-row full');
    aboutRow.appendChild(fieldGroup(
      'About the agent',
      textarea('profileBio', 3000, 6),
      'Describe your market experience, approach and the clients you serve.',
    ));
    fragment.appendChild(aboutRow);

    fragment.appendChild(heading('Organisation'));
    const organisationRow = row();
    organisationRow.append(
      fieldGroup('Organisation name', input('profileOrganizationName', 'text', 200)),
      fieldGroup('Role in organisation', input('profileOrganizationRole', 'text', 160)),
    );
    fragment.appendChild(organisationRow);

    const organisationLinks = row();
    organisationLinks.append(
      fieldGroup('Organisation website', input('profileOrganizationWebsite', 'url', 1000), 'HTTPS links only.'),
      fieldGroup('Organisation logo', input('profileOrganizationLogo', 'url', 1000), 'HTTPS or an uploaded PrimeProp image.'),
    );
    fragment.appendChild(organisationLinks);

    const addressRow = row('form-row full');
    addressRow.appendChild(fieldGroup('Office address', textarea('profileOrganizationAddress', 500, 3)));
    fragment.appendChild(addressRow);

    fragment.appendChild(heading('Practice details'));
    const experienceRow = row();
    const years = input('profileYearsExperience', 'number', 2);
    years.min = '0';
    years.max = '80';
    experienceRow.append(
      fieldGroup('Years of experience', years),
      fieldGroup('Typical response time', input('profileResponseTime', 'text', 120), 'Example: Usually within 2 hours'),
    );
    fragment.appendChild(experienceRow);

    const servicesRow = row('form-row full');
    servicesRow.appendChild(fieldGroup(
      'Specialties and services',
      textarea('profileSpecialties', 2000, 3),
      'Separate entries with commas, for example: Residential sales, Rentals, Land acquisition.',
    ));
    fragment.appendChild(servicesRow);

    const areasRow = row('form-row full');
    areasRow.appendChild(fieldGroup(
      'Areas served',
      textarea('profileServiceAreas', 2000, 3),
      'Separate cities, districts or neighbourhoods with commas.',
    ));
    fragment.appendChild(areasRow);

    const languagesRow = row();
    languagesRow.append(
      fieldGroup('Languages', input('profileLanguages', 'text', 1000), 'Comma-separated.'),
      fieldGroup('Professional memberships', input('profileMemberships', 'text', 2000), 'Comma-separated.'),
    );
    fragment.appendChild(languagesRow);

    const credentialRow = row();
    credentialRow.append(
      fieldGroup('Professional body', input('profileLicenseBody', 'text', 100), 'For example ESVARBON or NIESV, when applicable.'),
      fieldGroup('Registration number', input('profileLicenseNumber', 'text', 120)),
    );
    fragment.appendChild(credentialRow);

    fragment.appendChild(heading('Public contact'));
    const publicContact = row();
    publicContact.append(
      fieldGroup('Public email', input('profilePublicEmail', 'email', 254), 'Your login email is never published automatically.'),
      fieldGroup('Professional website', input('profileWebsite', 'url', 1000), 'HTTPS links only.'),
    );
    fragment.appendChild(publicContact);

    const availability = row();
    availability.append(
      fieldGroup('Office hours', input('profileOfficeHours', 'text', 250), 'Example: Mon–Fri, 9:00–17:00'),
      fieldGroup('LinkedIn', input('profileLinkedIn', 'url', 1000), 'HTTPS links only.'),
    );
    fragment.appendChild(availability);

    const social = row();
    social.appendChild(fieldGroup('Instagram', input('profileInstagram', 'url', 1000), 'HTTPS links only.'));
    const publishGroup = document.createElement('label');
    publishGroup.className = 'profile-publish-control';
    const publish = document.createElement('input');
    publish.id = 'profilePublished';
    publish.type = 'checkbox';
    publishGroup.append(
      publish,
      document.createTextNode(' Publish my agent profile and allow listing contact cards to open it'),
    );
    social.appendChild(publishGroup);
    fragment.appendChild(social);

    form.insertBefore(fragment, status);
    return true;
  }

  function populate(data) {
    profile = data || null;
    if (!profile || !installFields()) return;
    const values = {
      profileBio: profile.bio,
      profileOrganizationName: profile.organization_name,
      profileOrganizationRole: profile.organization_role,
      profileOrganizationWebsite: profile.organization_website,
      profileOrganizationAddress: profile.organization_address,
      profileOrganizationLogo: profile.organization_logo_url,
      profilePublicEmail: profile.public_email,
      profileWebsite: profile.website_url,
      profileServiceAreas: listValue(profile.service_areas),
      profileSpecialties: listValue(profile.specialties),
      profileLanguages: listValue(profile.languages),
      profileMemberships: listValue(profile.professional_memberships),
      profileYearsExperience: String(profile.years_experience || 0),
      profileLicenseBody: profile.license_body,
      profileLicenseNumber: profile.license_number,
      profileResponseTime: profile.response_time,
      profileOfficeHours: profile.office_hours,
      profileLinkedIn: profile.linkedin_url,
      profileInstagram: profile.instagram_url,
    };
    for (const [id, fieldValue] of Object.entries(values)) {
      const element = document.getElementById(id);
      if (element) element.value = fieldValue || '';
    }
    const published = document.getElementById('profilePublished');
    if (published) published.checked = profile.profile_published !== false;
  }

  function setStatus(message, error = false) {
    const status = document.getElementById('profileStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = error ? '#dc2626' : '#15803d';
  }

  async function load() {
    const body = await client.requestJson('/auth/profile-settings', {}, window.apiFetch);
    populate(body.data || null);
  }

  async function save() {
    const button = document.getElementById('profileSaveButton');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    setStatus('Saving profile…');

    try {
      const body = await client.requestJson('/auth/profile-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: value('profileName'),
          phone: value('profilePhone'),
          agent_title: value('profileAgentTitle'),
          avatar_url: value('profileAvatar'),
          bio: value('profileBio'),
          organization_name: value('profileOrganizationName'),
          organization_role: value('profileOrganizationRole'),
          organization_website: value('profileOrganizationWebsite'),
          organization_address: value('profileOrganizationAddress'),
          organization_logo_url: value('profileOrganizationLogo'),
          public_email: value('profilePublicEmail'),
          website_url: value('profileWebsite'),
          service_areas: splitList(value('profileServiceAreas')),
          specialties: splitList(value('profileSpecialties')),
          languages: splitList(value('profileLanguages')),
          professional_memberships: splitList(value('profileMemberships')),
          years_experience: Number(value('profileYearsExperience') || 0),
          license_body: value('profileLicenseBody'),
          license_number: value('profileLicenseNumber'),
          response_time: value('profileResponseTime'),
          office_hours: value('profileOfficeHours'),
          linkedin_url: value('profileLinkedIn'),
          instagram_url: value('profileInstagram'),
          profile_published: checked('profilePublished'),
        }),
      }, window.apiFetch);

      populate(body.data);
      if (window.USER && body.data) window.USER = { ...window.USER, ...body.data };
      const name = document.getElementById('agentName');
      if (name && body.data?.name) name.textContent = body.data.name;
      setStatus('Profile saved. Identity changes may return affected listings for administrator approval.');
      if (typeof window.loadData === 'function') await window.loadData();
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Profile could not be saved.', true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  document.addEventListener('submit', event => {
    if (event.target?.id !== 'agentProfileForm') return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    save();
  }, true);

  document.addEventListener('click', event => {
    if (!event.target.closest('#editProfileButton')) return;
    setTimeout(() => load().catch(error => {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Profile could not be loaded.', true);
    }), 0);
  });

  const observer = new MutationObserver(() => {
    if (installFields()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  installFields();
})();
