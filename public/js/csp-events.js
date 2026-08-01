/*
 * Temporary CSP compatibility bridge.
 *
 * The legacy HTML still contains inline event attributes. The production CSP
 * keeps script-src-attr 'none', so browsers never execute those attributes.
 * This external script handles a small, explicit allowlist without eval or
 * Function construction. Remove it after all event attributes are migrated to
 * addEventListener.
 */
(() => {
  'use strict';

  const ALLOWED_FUNCTIONS = new Set([
    'showSignup', 'showLogin', 'doLogout',
    'switchTab',
    'openAddModal', 'openEditModal', 'closeModal', 'saveListing',
    'openDistrictModal', 'closeDistrictModal', 'saveDistrict',
    'confirmDelete', 'confirmDeleteDistrict', 'closeConfirm',
    'openUserModal', 'closeUserModal', 'saveUser',
    'banUser', 'unbanUser', 'deleteUser',
    'addAmenity', 'removeAmenity',
    'addDistrictCheck', 'removeDistrictCheck',
    'addImgUrl', 'removeImgUrl',
    'onTypeChange',
    'handleAdminUpload', 'handleDistrictUpload',
    'handleAvatarUpload', 'handleUserAvatarUpload', 'handleFileUpload',
    'openLightbox', 'closeLightbox',
  ]);

  function splitArguments(source) {
    const args = [];
    let current = '';
    let quote = '';
    let escaped = false;
    let depth = 0;

    for (const char of source) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        current += char;
        escaped = true;
        continue;
      }
      if (quote) {
        current += char;
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        current += char;
        continue;
      }
      if (char === '[' || char === '{' || char === '(') depth += 1;
      if (char === ']' || char === '}' || char === ')') depth -= 1;
      if (char === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }

    if (current.trim()) args.push(current.trim());
    return args;
  }

  function parseArgument(source, event, element) {
    if (source === 'event') return event;
    if (source === 'this') return element;
    if (source === 'true') return true;
    if (source === 'false') return false;
    if (source === 'null') return null;
    if (/^-?\d+$/.test(source)) return Number(source);

    if (source.startsWith('"') && source.endsWith('"')) {
      return JSON.parse(source);
    }
    if (source.startsWith("'") && source.endsWith("'")) {
      return source
        .slice(1, -1)
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
    }
    if (source.startsWith('[') && source.endsWith(']')) {
      const parsed = JSON.parse(source);
      if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) {
        throw new Error('Only string arrays are permitted');
      }
      return parsed;
    }

    throw new Error('Unsupported inline argument');
  }

  function normalizeHandler(handler) {
    return handler
      .trim()
      .replace(/;\s*return\s+false\s*;?$/i, '')
      .replace(/;+$/, '')
      .trim();
  }

  function callAllowedHandler(element, event, attributeName) {
    const raw = element.getAttribute(attributeName);
    if (!raw) return false;
    const handler = normalizeHandler(raw);

    if (handler === 'event.stopPropagation()') {
      event.stopPropagation();
      return true;
    }

    const fileClick = handler.match(/^document\.getElementById\(['"]([A-Za-z][\w:-]*)['"]\)\.click\(\)$/);
    if (fileClick) {
      const target = document.getElementById(fileClick[1]);
      if (target instanceof HTMLElement) target.click();
      return true;
    }

    const pageCall = handler.match(/^window\.__ppGoTo\((\d+)\)$/);
    if (pageCall && typeof window.__ppGoTo === 'function') {
      window.__ppGoTo(Number(pageCall[1]));
      return true;
    }

    const match = handler.match(/^([A-Za-z_$][\w$]*)\((.*)\)$/s);
    if (!match || !ALLOWED_FUNCTIONS.has(match[1])) return false;

    const fn = window[match[1]];
    if (typeof fn !== 'function') return false;

    const argumentSource = match[2].trim();
    const args = argumentSource
      ? splitArguments(argumentSource).map(arg => parseArgument(arg, event, element))
      : [];

    fn(...args);
    return true;
  }

  function handleFavorite(button, event) {
    event.preventDefault();
    event.stopPropagation();
    const icon = button.querySelector('i');
    if (!icon) return;
    icon.classList.toggle('fa-regular');
    icon.classList.toggle('fa-solid');
    button.classList.toggle('is-saved', icon.classList.contains('fa-solid'));
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const favorite = target.closest('.fav-btn');
    if (favorite instanceof HTMLElement) {
      handleFavorite(favorite, event);
      return;
    }

    const actionable = target.closest('[onclick]');
    if (!(actionable instanceof HTMLElement)) return;

    try {
      if (callAllowedHandler(actionable, event, 'onclick')) {
        event.preventDefault();
      }
    } catch {
      // Refuse malformed or unsupported handler data without executing it.
    }
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('onsubmit')) return;

    try {
      if (callAllowedHandler(form, event, 'onsubmit')) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  document.addEventListener('change', event => {
    const element = event.target;
    if (!(element instanceof HTMLElement) || !element.hasAttribute('onchange')) return;

    try {
      callAllowedHandler(element, event, 'onchange');
    } catch {
      // Unsupported change handlers remain blocked by CSP.
    }
  });

  document.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.hasAttribute('onerror')) return;

    image.removeAttribute('onerror');
    image.hidden = true;
    const parent = image.parentElement;
    if (!parent || parent.querySelector('.pp-image-fallback')) return;

    parent.classList.add('pp-image-error');
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-image pp-image-fallback';
    icon.setAttribute('aria-hidden', 'true');
    parent.appendChild(icon);
  }, true);
})();
