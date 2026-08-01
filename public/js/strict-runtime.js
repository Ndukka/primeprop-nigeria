/* PrimeProp strict CSP runtime.
 *
 * This file contains no inline-handler parser and never evaluates strings as
 * JavaScript. It converts declarative data-pp-css values into nonce-authorized
 * stylesheet rules, attaches direct event listeners, and provides the shared
 * skeleton loading treatment used during full-page navigation.
 */
(() => {
  'use strict';

  const currentScript = document.currentScript;
  const nonce = currentScript instanceof HTMLScriptElement ? currentScript.nonce : '';
  const styleElement = document.createElement('style');
  if (nonce) styleElement.setAttribute('nonce', nonce);
  styleElement.setAttribute('data-primeprop-runtime-styles', '');
  document.head.appendChild(styleElement);

  const sheet = styleElement.sheet;
  const ruleClasses = new Map();
  const elementProperties = new WeakMap();
  const replacementListeners = new WeakMap();
  let ruleSequence = 0;
  let pageSkeleton = null;
  let navigationStarted = false;

  const STATIC_RULES = [
    '.pp-image-error{position:relative;min-height:180px;background:linear-gradient(135deg,#e2e8f0 0%,#f1f5f9 100%)}',
    '.pp-image-fallback{position:absolute;inset:50% auto auto 50%;transform:translate(-50%,-50%);color:#94a3b8;font-size:3rem;pointer-events:none}',
    '.fav-btn.is-saved i{color:#dc2626}',
    '.pp-page-skeleton{position:fixed;inset:0;z-index:2147483000;background:#f8fafc;display:grid;grid-template-rows:auto 1fr;overflow:hidden}',
    '.pp-page-skeleton__header{height:78px;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:18px;padding:0 max(24px,calc((100vw - 1240px)/2))}',
    '.pp-page-skeleton__logo{width:170px;height:38px;border-radius:10px}',
    '.pp-page-skeleton__nav{display:flex;gap:14px;flex:1;justify-content:center}',
    '.pp-page-skeleton__nav-item{width:72px;height:12px;border-radius:999px}',
    '.pp-page-skeleton__button{width:148px;height:40px;border-radius:9px}',
    '.pp-page-skeleton__body{width:min(1240px,calc(100% - 48px));margin:0 auto;padding:34px 0 48px;display:grid;gap:24px;align-content:start}',
    '.pp-page-skeleton__hero{height:210px;border-radius:22px}',
    '.pp-page-skeleton__title{width:min(480px,72%);height:28px;border-radius:999px}',
    '.pp-page-skeleton__subtitle{width:min(680px,88%);height:14px;border-radius:999px}',
    '.pp-page-skeleton__grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}',
    '.pp-page-skeleton__card{height:260px;border-radius:18px}',
    '.pp-page-skeleton__pulse{background:linear-gradient(90deg,#e2e8f0 25%,#fff 50%,#e2e8f0 75%);background-size:200% 100%;animation:pp-page-skeleton-shimmer 1.15s ease-in-out infinite}',
    '@keyframes pp-page-skeleton-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
    '@media(max-width:760px){.pp-page-skeleton__header{height:68px;padding:0 18px}.pp-page-skeleton__nav{display:none}.pp-page-skeleton__button{width:104px}.pp-page-skeleton__body{width:calc(100% - 32px);padding-top:24px}.pp-page-skeleton__hero{height:170px}.pp-page-skeleton__grid{grid-template-columns:1fr}.pp-page-skeleton__card{height:210px}}',
    '@media(prefers-reduced-motion:reduce){.pp-page-skeleton__pulse{animation:none;background:#e2e8f0}}',
  ];
  if (sheet) {
    for (const rule of STATIC_RULES) sheet.insertRule(rule, sheet.cssRules.length);
  }

  function cssPropertyName(property) {
    return String(property)
      .replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
      .trim()
      .toLowerCase();
  }

  function isSafeProperty(property) {
    return /^[a-z][a-z0-9-]{0,63}$/.test(property)
      && !property.startsWith('--');
  }

  function isSafeValue(value) {
    const text = String(value).trim();
    return text.length <= 500
      && !/[{}]/.test(text)
      && !/@import/i.test(text)
      && !<\/?style/i.test(text)
      && !/expression\s*\(/i.test(text)
      && !/javascript\s*:/i.test(text);
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function classFor(property, value) {
    const key = `${property}:${value}`;
    const existing = ruleClasses.get(key);
    if (existing) return existing;

    const className = `pp-runtime-${stableHash(key)}-${ruleSequence++}`;
    if (sheet) sheet.insertRule(`.${className}{${property}:${value}!important}`, sheet.cssRules.length);
    ruleClasses.set(key, className);
    return className;
  }

  function setRuntimeStyle(element, property, rawValue) {
    if (!(element instanceof Element)) return;
    const normalizedProperty = cssPropertyName(property);
    const value = String(rawValue ?? '').trim();
    if (!isSafeProperty(normalizedProperty) || !isSafeValue(value)) return;

    let state = elementProperties.get(element);
    if (!state) {
      state = new Map();
      elementProperties.set(element, state);
    }

    const previous = state.get(normalizedProperty);
    if (previous) element.classList.remove(previous);

    if (!value) {
      state.delete(normalizedProperty);
      return;
    }

    const className = classFor(normalizedProperty, value);
    element.classList.add(className);
    state.set(normalizedProperty, className);
  }

  function applyDeclaration(element, declaration) {
    for (const part of String(declaration).split(';')) {
      const separator = part.indexOf(':');
      if (separator <= 0) continue;
      const property = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      setRuntimeStyle(element, property, value);
    }
  }

  function replaceEventListener(target, eventName, listener) {
    if (!(target instanceof EventTarget)) return;
    const normalizedEvent = String(eventName).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(normalizedEvent)) return;

    let listeners = replacementListeners.get(target);
    if (!listeners) {
      listeners = new Map();
      replacementListeners.set(target, listeners);
    }

    const previous = listeners.get(normalizedEvent);
    if (previous) target.removeEventListener(normalizedEvent, previous);

    if (typeof listener !== 'function') {
      listeners.delete(normalizedEvent);
      return;
    }

    target.addEventListener(normalizedEvent, listener);
    listeners.set(normalizedEvent, listener);
  }

  function handleImageFailure(image) {
    if (!(image instanceof HTMLImageElement) || image.dataset.ppFallbackBound === 'done') return;
    image.dataset.ppFallbackBound = 'done';
    image.hidden = true;
    const parent = image.parentElement;
    if (!parent || parent.querySelector('.pp-image-fallback')) return;
    parent.classList.add('pp-image-error');
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-image pp-image-fallback';
    icon.setAttribute('aria-hidden', 'true');
    parent.appendChild(icon);
  }

  function attachDirectListener(element, key, eventName, listener, options) {
    const marker = `ppBound${key}`;
    if (element.dataset[marker] === 'true') return;
    element.dataset[marker] = 'true';
    element.addEventListener(eventName, listener, options);
  }

  function createPulse(className) {
    const element = document.createElement('span');
    element.className = `${className} pp-page-skeleton__pulse`;
    element.setAttribute('aria-hidden', 'true');
    return element;
  }

  function showPageSkeleton() {
    if (pageSkeleton || !document.body) return;

    const overlay = document.createElement('div');
    overlay.className = 'pp-page-skeleton';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('aria-label', 'Loading the next page');

    const header = document.createElement('div');
    header.className = 'pp-page-skeleton__header';
    header.appendChild(createPulse('pp-page-skeleton__logo'));

    const nav = document.createElement('div');
    nav.className = 'pp-page-skeleton__nav';
    for (let index = 0; index < 5; index += 1) {
      nav.appendChild(createPulse('pp-page-skeleton__nav-item'));
    }
    header.appendChild(nav);
    header.appendChild(createPulse('pp-page-skeleton__button'));

    const body = document.createElement('div');
    body.className = 'pp-page-skeleton__body';
    body.appendChild(createPulse('pp-page-skeleton__hero'));
    body.appendChild(createPulse('pp-page-skeleton__title'));
    body.appendChild(createPulse('pp-page-skeleton__subtitle'));

    const grid = document.createElement('div');
    grid.className = 'pp-page-skeleton__grid';
    for (let index = 0; index < 3; index += 1) {
      grid.appendChild(createPulse('pp-page-skeleton__card'));
    }
    body.appendChild(grid);

    overlay.append(header, body);
    document.body.appendChild(overlay);
    pageSkeleton = overlay;
  }

  function removePageSkeleton() {
    if (pageSkeleton) pageSkeleton.remove();
    pageSkeleton = null;
    navigationStarted = false;
  }

  function navigableAnchorFromEvent(event) {
    if (event.defaultPrevented || event.button !== 0) return null;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
    const target = event.target;
    if (!(target instanceof Element)) return null;
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return null;
    if (anchor.target && anchor.target !== '_self') return null;
    if (anchor.hasAttribute('download') || anchor.hasAttribute('data-no-page-skeleton')) return null;
    if (/^(?:mailto:|tel:|javascript:)/i.test(anchor.getAttribute('href') || '')) return null;
    return anchor;
  }

  function scheduleNavigation(url) {
    if (navigationStarted) return;
    navigationStarted = true;
    showPageSkeleton();
    requestAnimationFrame(() => {
      window.location.assign(url.href);
    });
  }

  function bindNavigationSkeleton() {
    document.addEventListener('click', event => {
      const anchor = navigableAnchorFromEvent(event);
      if (!anchor) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (
        url.pathname === window.location.pathname
        && url.search === window.location.search
        && url.hash
      ) return;
      if (url.href === window.location.href) return;

      event.preventDefault();
      scheduleNavigation(url);
    }, true);

    document.addEventListener('submit', event => {
      if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
      const form = event.target;
      const method = (form.method || 'get').toLowerCase();
      if (method !== 'get' || form.target) return;

      const url = new URL(form.action || window.location.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const params = new URLSearchParams(new FormData(form));
      url.search = params.toString();

      event.preventDefault();
      scheduleNavigation(url);
    }, true);

    window.addEventListener('pageshow', removePageSkeleton);
  }

  function bindElement(element) {
    if (!(element instanceof Element)) return;

    if (element.hasAttribute('data-pp-css')) {
      applyDeclaration(element, element.getAttribute('data-pp-css') || '');
      element.removeAttribute('data-pp-css');
    }

    if (element.matches('[data-pp-image-fallback]') && element instanceof HTMLImageElement) {
      attachDirectListener(element, 'ImageFallback', 'error', () => handleImageFailure(element));
      if (element.complete && element.naturalWidth === 0) handleImageFailure(element);
    }

    if (element.matches('[data-pp-stop-propagation]')) {
      attachDirectListener(element, 'StopPropagation', 'click', event => event.stopPropagation());
    }

    const action = element.getAttribute('data-pp-action');
    if (action === 'favorite') {
      attachDirectListener(element, 'Favorite', 'click', event => {
        event.preventDefault();
        event.stopPropagation();
        const icon = element.querySelector('i');
        if (!icon) return;
        icon.classList.toggle('fa-regular');
        icon.classList.toggle('fa-solid');
        element.classList.toggle('is-saved', icon.classList.contains('fa-solid'));
      });
    }

    if (action === 'page') {
      attachDirectListener(element, 'Page', 'click', event => {
        event.preventDefault();
        const page = Number(element.getAttribute('data-pp-page'));
        if (Number.isInteger(page) && page > 0 && typeof window.__ppGoTo === 'function') {
          window.__ppGoTo(page);
        }
      });
    }

    if (action === 'lightbox') {
      attachDirectListener(element, 'Lightbox', 'click', event => {
        event.preventDefault();
        const rawImages = element.getAttribute('data-pp-images') || '[]';
        const index = Number(element.getAttribute('data-pp-index') || '0');
        try {
          const images = JSON.parse(rawImages);
          if (Array.isArray(images) && images.every(item => typeof item === 'string') && typeof window.openLightbox === 'function') {
            window.openLightbox(images, Number.isInteger(index) ? index : 0);
          }
        } catch {
          // Malformed declarative data is ignored rather than evaluated.
        }
      });
    }
  }

  function scan(root) {
    if (root instanceof Element) bindElement(root);
    if (!(root instanceof Document || root instanceof DocumentFragment || root instanceof Element)) return;
    root.querySelectorAll('[data-pp-css], [data-pp-image-fallback], [data-pp-stop-propagation], [data-pp-action]')
      .forEach(bindElement);
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) scan(node);
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => scan(document), { once: true });
  bindNavigationSkeleton();
  scan(document);

  window.PrimePropStyles = Object.freeze({
    set: setRuntimeStyle,
    apply: applyDeclaration,
    scan,
  });
  window.PrimePropEvents = Object.freeze({
    replace: replaceEventListener,
  });
  window.PrimePropLoading = Object.freeze({
    show: showPageSkeleton,
    hide: removePageSkeleton,
  });
})();