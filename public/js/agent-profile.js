/* PrimeProp public agent profile page. */
(() => {
  'use strict';

  const root = document.getElementById('agentProfileContent');
  if (!root) return;

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function icon(name) {
    const element = document.createElement('i');
    element.className = name;
    element.setAttribute('aria-hidden', 'true');
    return element;
  }

  function safeHttps(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.toString() : '';
    } catch {
      return '';
    }
  }

  function safeMedia(value) {
    if (typeof value !== 'string' || !value) return '';
    if (value.startsWith('/api/images/')) return value;
    return safeHttps(value);
  }

  function initials(name) {
    return String(name || 'Agent')
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'AG';
  }

  function phoneDigits(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0')) digits = `234${digits.slice(1)}`;
    return /^\d{10,15}$/.test(digits) ? digits : '';
  }

  function buttonLink(label, iconClass, href, className, external = false) {
    const link = node('a', `btn ${className}`);
    link.href = href;
    link.append(icon(iconClass), document.createTextNode(label));
    if (external) {
      link.target = '_blank';
      link.rel = 'noopener';
    }
    return link;
  }

  function renderAvatar(profile) {
    const avatar = safeMedia(profile.avatarUrl);
    if (!avatar) return node('div', 'agent-profile-initials', initials(profile.name));
    const image = node('img', 'agent-profile-avatar');
    image.src = avatar;
    image.alt = `${profile.name} profile photograph`;
    image.addEventListener('error', () => image.replaceWith(node('div', 'agent-profile-initials', initials(profile.name))));
    return image;
  }

  function appendTags(parent, values, iconClass) {
    const list = node('div', 'agent-profile-tags');
    for (const value of Array.isArray(values) ? values : []) {
      const tag = node('span', 'agent-profile-tag');
      tag.append(icon(iconClass), document.createTextNode(String(value)));
      list.appendChild(tag);
    }
    parent.appendChild(list);
  }

  function section(title, content) {
    const wrapper = node('section', 'agent-profile-section');
    wrapper.appendChild(node('h2', '', title));
    if (typeof content === 'string') wrapper.appendChild(node('p', '', content));
    else wrapper.appendChild(content);
    return wrapper;
  }

  function detail(label, value, href = '') {
    const item = node('div', 'agent-profile-detail');
    item.appendChild(node('span', '', label));
    if (href) {
      const link = node('a', '', value);
      link.href = href;
      if (href.startsWith('https://')) {
        link.target = '_blank';
        link.rel = 'noopener';
      }
      item.appendChild(link);
    } else item.appendChild(node('strong', '', value));
    return item;
  }

  function contactItem(iconClass, value, href = '') {
    const item = node('div', 'agent-profile-contact-item');
    item.appendChild(icon(iconClass));
    if (href) {
      const link = node('a', '', value);
      link.href = href;
      if (href.startsWith('https://')) {
        link.target = '_blank';
        link.rel = 'noopener';
      }
      item.appendChild(link);
    } else item.appendChild(node('span', '', value));
    return item;
  }

  function displayYear(dateValue) {
    const date = new Date(dateValue);
    return Number.isNaN(date.getTime()) ? '—' : String(date.getFullYear());
  }

  function renderError(message) {
    clear(root);
    const box = node('div', 'agent-profile-error');
    box.append(
      icon('fa-solid fa-user-slash'),
      node('h1', '', 'Agent profile unavailable'),
      node('p', '', message || 'This profile is not available.'),
      buttonLink('Browse active listings', 'fa-solid fa-arrow-right', '/properties', 'btn-primary'),
    );
    root.appendChild(box);
  }

  function renderListings(profile) {
    const sectionElement = node('section', 'agent-profile-listings');
    const header = node('div', 'agent-profile-listings-header');
    const copy = node('div');
    copy.append(
      node('h2', '', 'Active listings'),
      node('p', '', 'Only administrator-approved listings currently visible in the public catalogue are shown.'),
    );
    header.append(copy, buttonLink('Browse all listings', 'fa-solid fa-arrow-right', '/properties', 'btn-outline'));
    sectionElement.appendChild(header);

    if (!Array.isArray(profile.listings) || profile.listings.length === 0) {
      sectionElement.appendChild(node('div', 'agent-profile-empty', 'This agent has no active public listings at the moment.'));
      return sectionElement;
    }

    const grid = node('div', 'listings-grid');
    if (typeof window.renderPropertyCard === 'function') {
      grid.innerHTML = profile.listings.map(window.renderPropertyCard).join('');
    } else {
      for (const listing of profile.listings) {
        const card = node('article', 'property-card');
        const body = node('div', 'property-card-body');
        body.append(
          node('div', 'price', listing.priceDisplay || `₦${Number(listing.price || 0).toLocaleString()}`),
          node('div', 'title', listing.title || 'Property listing'),
          node('div', 'location', listing.location || ''),
          buttonLink('View listing', 'fa-solid fa-arrow-right', `/listing-detail?id=${encodeURIComponent(listing.id)}`, 'btn-outline btn-sm'),
        );
        card.appendChild(body);
        grid.appendChild(card);
      }
    }
    sectionElement.appendChild(grid);
    return sectionElement;
  }

  function renderProfile(profile) {
    clear(root);
    document.title = `${profile.name || 'Agent'} | PrimeProp Nigeria`;

    const hero = node('section', 'agent-profile-hero');
    hero.appendChild(renderAvatar(profile));

    const identity = node('div');
    identity.appendChild(node('div', 'agent-profile-kicker', 'PrimeProp agent profile'));
    const nameRow = node('div', 'agent-profile-name-row');
    nameRow.appendChild(node('h1', '', profile.name || 'PrimeProp Agent'));
    if (profile.verified) {
      const verified = node('span', 'agent-profile-verified');
      verified.append(icon('fa-solid fa-circle-check'), document.createTextNode('Profile verified'));
      nameRow.appendChild(verified);
    }
    identity.appendChild(nameRow);
    identity.appendChild(node('p', 'agent-profile-title', profile.agentTitle || 'Listing Agent'));

    if (profile.organization?.name) {
      const organization = node('div', 'agent-profile-organization');
      const logo = safeMedia(profile.organization.logoUrl);
      if (logo) {
        const image = node('img', 'agent-profile-organization-logo');
        image.src = logo;
        image.alt = `${profile.organization.name} logo`;
        image.addEventListener('error', () => image.remove());
        organization.appendChild(image);
      } else organization.appendChild(icon('fa-solid fa-building'));
      organization.appendChild(document.createTextNode([
        profile.organization.name,
        profile.organization.role,
      ].filter(Boolean).join(' · ')));
      identity.appendChild(organization);
    }
    hero.appendChild(identity);

    const actions = node('div', 'agent-profile-hero-actions');
    const digits = phoneDigits(profile.contact?.phone);
    if (digits) {
      const message = encodeURIComponent(`Hello ${profile.name}, I found your profile on PrimeProp Nigeria and would like to discuss a property requirement.`);
      actions.append(
        buttonLink('Chat on WhatsApp', 'fa-brands fa-whatsapp', `https://wa.me/${digits}?text=${message}`, 'btn-whatsapp', true),
        buttonLink('Call agent', 'fa-solid fa-phone', `tel:+${digits}`, 'btn-outline'),
      );
    }
    if (profile.contact?.email) {
      actions.appendChild(buttonLink('Email agent', 'fa-solid fa-envelope', `mailto:${profile.contact.email}`, 'btn-outline'));
    }
    if (!actions.children.length) {
      actions.appendChild(buttonLink('View active listings', 'fa-solid fa-house', '#active-listings', 'btn-primary'));
    }
    hero.appendChild(actions);
    root.appendChild(hero);

    const stats = node('section', 'agent-profile-stats');
    const statValues = [
      [String(profile.activeListingCount || 0), 'Active listings'],
      [profile.yearsExperience ? `${profile.yearsExperience}+` : '—', 'Years of experience'],
      [String((profile.serviceAreas || []).length), 'Service areas'],
      [profile.contact?.responseTime || '—', 'Typical response'],
    ];
    for (const [value, label] of statValues) {
      const stat = node('div', 'agent-profile-stat');
      stat.append(node('strong', '', value), node('span', '', label));
      stats.appendChild(stat);
    }
    root.appendChild(stats);

    const layout = node('div', 'agent-profile-grid');
    const main = node('div', 'agent-profile-main');
    const sidebar = node('aside', 'agent-profile-sidebar');

    if (profile.bio) main.appendChild(section('About', profile.bio));
    if (profile.specialties?.length) {
      const content = node('div');
      appendTags(content, profile.specialties, 'fa-solid fa-house-circle-check');
      main.appendChild(section('Specialties and services', content));
    }
    if (profile.serviceAreas?.length) {
      const content = node('div');
      appendTags(content, profile.serviceAreas, 'fa-solid fa-location-dot');
      main.appendChild(section('Areas served', content));
    }
    if (profile.languages?.length) {
      const content = node('div');
      appendTags(content, profile.languages, 'fa-solid fa-language');
      main.appendChild(section('Languages', content));
    }

    const professionalDetails = node('div', 'agent-profile-details');
    if (profile.credential?.body) professionalDetails.appendChild(detail('Professional body', profile.credential.body));
    if (profile.credential?.number) professionalDetails.appendChild(detail('Registration number', profile.credential.number));
    if (profile.professionalMemberships?.length) {
      professionalDetails.appendChild(detail('Memberships', profile.professionalMemberships.join(', ')));
    }
    professionalDetails.appendChild(detail('PrimeProp member since', displayYear(profile.memberSince)));
    if (profile.organization?.address) professionalDetails.appendChild(detail('Office address', profile.organization.address));
    const organizationWebsite = safeHttps(profile.organization?.website);
    if (organizationWebsite) professionalDetails.appendChild(detail('Organisation website', 'Visit website', organizationWebsite));
    if (professionalDetails.children.length) main.appendChild(section('Professional details', professionalDetails));

    const contact = node('section', 'agent-profile-contact');
    contact.appendChild(node('h2', '', 'Contact and availability'));
    const contactList = node('div', 'agent-profile-contact-list');
    if (profile.contact?.phone) contactList.appendChild(contactItem('fa-solid fa-phone', profile.contact.phone, digits ? `tel:+${digits}` : ''));
    if (profile.contact?.email) contactList.appendChild(contactItem('fa-solid fa-envelope', profile.contact.email, `mailto:${profile.contact.email}`));
    const website = safeHttps(profile.contact?.website);
    if (website) contactList.appendChild(contactItem('fa-solid fa-globe', 'Professional website', website));
    if (profile.contact?.officeHours) contactList.appendChild(contactItem('fa-regular fa-clock', profile.contact.officeHours));
    if (profile.contact?.responseTime) contactList.appendChild(contactItem('fa-solid fa-reply', profile.contact.responseTime));
    const linkedin = safeHttps(profile.contact?.linkedinUrl);
    const instagram = safeHttps(profile.contact?.instagramUrl);
    if (linkedin) contactList.appendChild(contactItem('fa-brands fa-linkedin', 'LinkedIn', linkedin));
    if (instagram) contactList.appendChild(contactItem('fa-brands fa-instagram', 'Instagram', instagram));
    if (!contactList.children.length) contactList.appendChild(contactItem('fa-solid fa-circle-info', 'Contact the agent through one of their active property listings.'));
    contact.appendChild(contactList);
    sidebar.appendChild(contact);

    const trust = node('section', 'agent-profile-trust');
    trust.appendChild(node('h2', '', 'Before you proceed'));
    const list = node('ul');
    for (const text of [
      'Confirm the agent’s authority to market the specific property.',
      'Verify title, planning and ownership documents independently.',
      'Inspect the property and use your own lawyer or surveyor before payment.',
      'A profile badge does not replace transaction-level due diligence.',
    ]) {
      const item = node('li');
      item.append(icon('fa-solid fa-circle-check'), document.createTextNode(text));
      list.appendChild(item);
    }
    trust.appendChild(list);
    sidebar.appendChild(trust);

    layout.append(main, sidebar);
    root.appendChild(layout);
    const listings = renderListings(profile);
    listings.id = 'active-listings';
    root.appendChild(listings);
  }

  async function initialize() {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id || !/^\d+$/.test(id)) {
      renderError('Select an agent from an active property listing to view their profile.');
      return;
    }

    try {
      const response = await fetch(`/auth/public-agents/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success || !body.data) {
        throw new Error(body?.message || 'This profile is not available.');
      }
      renderProfile(body.data);
    } catch (error) {
      console.error(error);
      renderError(error instanceof Error ? error.message : 'This profile is not available.');
    }
  }

  initialize();
})();
