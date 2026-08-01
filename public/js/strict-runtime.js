/* PrimeProp strict CSP runtime.
 *
 * This file contains no inline-handler parser and never evaluates strings as
 * JavaScript. It converts declarative data-pp-style values into nonce-authorized
 * stylesheet rules and attaches direct event listeners to dynamic elements.
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
  let ruleSequence = 0;

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
      && !/<\/?style/i.test(text)
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

  function bindElement(element) {
    if (!(element instanceof Element)) return;

    if (element.hasAttribute('data-pp-style')) {
      applyDeclaration(element, element.getAttribute('data-pp-style') || '');
      element.removeAttribute('data-pp-style');
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
    root.querySelectorAll('[data-pp-style], [data-pp-image-fallback], [data-pp-stop-propagation], [data-pp-action]')
      .forEach(bindElement);
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) scan(node);
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => scan(document), { once: true });
  scan(document);

  window.PrimePropStyles = Object.freeze({
    set: setRuntimeStyle,
    apply: applyDeclaration,
    scan,
  });
})();
