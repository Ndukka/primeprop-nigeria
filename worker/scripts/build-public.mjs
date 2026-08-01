import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, '..');
const repositoryDir = path.resolve(workerDir, '..');
const sourceDir = path.join(repositoryDir, 'public');
const outputDir = path.join(repositoryDir, 'dist-public');
const assetsDir = path.join(outputDir, 'assets');

const OMITTED_SOURCE_FILES = new Set([
  'csp-compat.css',
  'js/csp-events.js',
]);

const PAGE_PATHS = new Map([
  ['index.html', '/'],
  ['properties.html', '/properties'],
  ['properties-rent.html', '/properties-rent'],
  ['properties-sale.html', '/properties-sale'],
  ['properties-land.html', '/properties-land'],
  ['areas.html', '/areas'],
  ['listing-detail.html', '/listing-detail'],
  ['listing-detail-1.html', '/listing-detail-1'],
  ['listing-detail-2.html', '/listing-detail-2'],
  ['listing-detail-3.html', '/listing-detail-3'],
  ['login.html', '/login'],
  ['admin.html', '/admin'],
  ['agent.html', '/agent'],
  ['reset-password.html', '/reset-password'],
]);

function normalizeRelative(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function walk(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute, base));
    else files.push(normalizeRelative(path.relative(base, absolute)));
  }
  return files.sort();
}

function shortHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function generatedAssetPath(relativePath, content) {
  const extension = path.extname(relativePath);
  const stem = relativePath.slice(0, -extension.length).replace(/[^a-zA-Z0-9/_-]/g, '-');
  return `assets/${stem}.${shortHash(content)}${extension}`;
}

async function emitAsset(relativePath, content) {
  const outputRelative = generatedAssetPath(relativePath, content);
  const absolute = path.join(outputDir, outputRelative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
  return `/${normalizeRelative(outputRelative)}`;
}

function toKebabCase(property) {
  return property.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
}

function transformStyleAssignments(source, sourceName) {
  const assignmentPattern = /(\b(?:this|document|window|[A-Za-z_$][\w$]*)(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[[^\]\n]+\])|(?:\([^;\n]*?\)))*?)\.style\.([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);/g;
  const transformed = source.replace(assignmentPattern, (_match, objectExpression, property, value) => {
    return `window.PrimePropStyles.set(${objectExpression}, '${toKebabCase(property)}', ${value});`;
  });

  if (/\.style\s*(?:\.|\[)/.test(transformed) || /\.style\s*=/.test(transformed)) {
    throw new Error(`${sourceName}: unsupported .style usage remains after transformation`);
  }
  return transformed;
}

function findClosingAttributeQuote(source, start, escapedDelimiter, quote) {
  for (let index = start; index < source.length; index += 1) {
    if (escapedDelimiter) {
      if (source[index] === '\\' && source[index + 1] === quote) return index;
      continue;
    }
    if (source[index] !== quote) continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function splitArguments(source) {
  const argumentsList = [];
  let current = '';
  let quote = '';
  let escaped = false;
  let depth = 0;

  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    if (')]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) {
      argumentsList.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }

  if (current.trim()) argumentsList.push(current.trim());
  return argumentsList;
}

function quoteAttribute(name, value, escapedDelimiter) {
  const quote = escapedDelimiter ? '\\"' : '"';
  return `${name}=${quote}${value}${quote}`;
}

function rewriteJavascriptHtmlAttributes(source, sourceName) {
  const attributeStart = /\b(style|on[a-z]+)=(\\?)(["'])/gi;
  let cursor = 0;
  let output = '';
  let match;

  while ((match = attributeStart.exec(source)) !== null) {
    const [opening, rawName, slash, quote] = match;
    const escapedDelimiter = slash === '\\';
    const valueStart = match.index + opening.length;
    const closingIndex = findClosingAttributeQuote(source, valueStart, escapedDelimiter, quote);
    if (closingIndex < 0) throw new Error(`${sourceName}: unterminated ${rawName} attribute in JavaScript markup`);

    const closingLength = escapedDelimiter ? 2 : 1;
    const rawValue = source.slice(valueStart, closingIndex);
    const normalizedName = rawName.toLowerCase();
    output += source.slice(cursor, match.index);

    if (normalizedName === 'style') {
      output += quoteAttribute('data-pp-style', rawValue, escapedDelimiter);
    } else if (normalizedName === 'onerror') {
      output += quoteAttribute('data-pp-image-fallback', 'true', escapedDelimiter);
    } else if (normalizedName === 'onclick') {
      const handler = rawValue.trim().replace(/;+$/, '');
      if (/classList\.toggle\(['"]fa-regular['"]\)/.test(handler)) {
        output += quoteAttribute('data-pp-action', 'favorite', escapedDelimiter);
      } else if (handler === 'event.stopPropagation()') {
        output += quoteAttribute('data-pp-stop-propagation', 'true', escapedDelimiter);
      } else {
        const pageMatch = handler.match(/^window\.__ppGoTo\((.*)\)$/s);
        const lightboxMatch = handler.match(/^openLightbox\((.*)\)$/s);
        if (pageMatch) {
          output += `${quoteAttribute('data-pp-action', 'page', escapedDelimiter)} ${quoteAttribute('data-pp-page', pageMatch[1].trim(), escapedDelimiter)}`;
        } else if (lightboxMatch) {
          const args = splitArguments(lightboxMatch[1]);
          if (args.length !== 2) throw new Error(`${sourceName}: unsupported openLightbox handler`);
          output += `${quoteAttribute('data-pp-action', 'lightbox', escapedDelimiter)} ${quoteAttribute('data-pp-images', args[0], escapedDelimiter)} ${quoteAttribute('data-pp-index', args[1], escapedDelimiter)}`;
        } else {
          throw new Error(`${sourceName}: unsupported dynamic onclick handler: ${handler.slice(0, 160)}`);
        }
      }
    } else {
      throw new Error(`${sourceName}: unsupported dynamic ${normalizedName} handler`);
    }

    cursor = closingIndex + closingLength;
    attributeStart.lastIndex = cursor;
  }

  output += source.slice(cursor);
  return output;
}

function rewriteKnownPageUrls(source) {
  let output = source;
  for (const [filename, cleanPath] of PAGE_PATHS) {
    output = output.replace(new RegExp(`(?<![A-Za-z0-9_-])(?:\\./)?${filename.replace('.', '\\.')}(?=([?#]|["'\\s<]))`, 'g'), cleanPath);
  }
  return output;
}

function transformJavaScript(source, sourceName) {
  let output = rewriteJavascriptHtmlAttributes(source, sourceName);
  output = transformStyleAssignments(output, sourceName);
  output = rewriteKnownPageUrls(output);

  if (/\bon(?:click|error|submit|change|input|load)\s*=/.test(output)) {
    throw new Error(`${sourceName}: inline event attribute remains in JavaScript output`);
  }
  if (/\bstyle\s*=\s*(?:\\?["'])/.test(output)) {
    throw new Error(`${sourceName}: inline style attribute remains in JavaScript output`);
  }
  return output;
}

function decodeAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function addClass(attributes, className) {
  const classPattern = /\sclass\s*=\s*(["'])(.*?)\1/i;
  if (classPattern.test(attributes)) {
    return attributes.replace(classPattern, (_match, quote, classes) => ` class=${quote}${classes} ${className}${quote}`);
  }
  return `${attributes} class="${className}"`;
}

function compileStaticTagAttributes(html, pageName, cssRules, eventBindings) {
  let sequence = 0;
  return html.replace(/<([A-Za-z][A-Za-z0-9:-]*)(\s[^<>]*?)?>/g, (tag, tagName, rawAttributes = '') => {
    if (tag.startsWith('</') || tag.startsWith('<!')) return tag;
    let attributes = rawAttributes;

    attributes = attributes.replace(/\sstyle\s*=\s*(["'])(.*?)\1/gi, (_match, _quote, declaration) => {
      const decoded = decodeAttribute(declaration).trim();
      const className = `pp-inline-${shortHash(`${pageName}:${decoded}`)}`;
      cssRules.set(className, decoded);
      return '';
    });

    for (const className of cssRules.keys()) {
      if (!tag.includes(className) && rawAttributes.includes(`style=`) && cssRules.get(className) === decodeAttribute((rawAttributes.match(/\sstyle\s*=\s*(["'])(.*?)\1/i) || [])[2] || '').trim()) {
        attributes = addClass(attributes, className);
        break;
      }
    }

    attributes = attributes.replace(/\son([a-z]+)\s*=\s*(["'])(.*?)\2/gi, (_match, eventName, _quote, handlerSource) => {
      const bindingId = `${pageName.replace(/[^a-z0-9]/gi, '-')}-${eventName}-${sequence++}`;
      let handler = decodeAttribute(handlerSource)
        .replace(/;?\s*return\s+false\s*;?$/i, '; event.preventDefault();')
        .trim();
      handler = transformStyleAssignments(handler, `${pageName}:${eventName}`);
      eventBindings.push({ bindingId, eventName: eventName.toLowerCase(), handler });
      return ` data-pp-bind="${bindingId}"`;
    });

    return `<${tagName}${attributes}>`;
  });
}

function staticEventScript(bindings) {
  if (bindings.length === 0) return '';
  const body = bindings.map(({ bindingId, eventName, handler }) => `
  {
    const element = document.querySelector('[data-pp-bind="${bindingId}"]');
    if (element) element.addEventListener('${eventName}', function(event) {
      ${handler}
    });
  }`).join('\n');

  return `document.addEventListener('DOMContentLoaded', () => {${body}\n}, { once: true });\n`;
}

function rewriteHtmlReference(value, assetMap) {
  if (!value || /^(?:https?:|mailto:|tel:|data:|blob:|#)/i.test(value)) return value;
  const [pathPart, suffix = ''] = value.split(/(?=[?#])/s, 2);
  const normalized = pathPart.replace(/^\.\//, '').replace(/^\//, '');
  if (assetMap.has(normalized)) return `${assetMap.get(normalized)}${suffix}`;
  if (PAGE_PATHS.has(normalized)) return `${PAGE_PATHS.get(normalized)}${suffix}`;
  return value.startsWith('/') ? value : `/${value}`;
}

function rewriteHtmlReferences(html, assetMap) {
  return html.replace(/\b(href|src)\s*=\s*(["'])(.*?)\2/gi, (_match, attribute, quote, value) => {
    return `${attribute}=${quote}${rewriteHtmlReference(value, assetMap)}${quote}`;
  });
}

function assertStrictHtml(html, pageName) {
  if (/\sstyle\s*=/i.test(html)) throw new Error(`${pageName}: style attribute remains in deployable HTML`);
  if (/\son[a-z]+\s*=/i.test(html)) throw new Error(`${pageName}: inline event attribute remains in deployable HTML`);
  if (/<style\b/i.test(html)) throw new Error(`${pageName}: inline style block remains in deployable HTML`);
  if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error(`${pageName}: inline script block remains in deployable HTML`);
  if (/(?:href|src)=["'](?!https?:|mailto:|tel:|data:|blob:|#|\/)/i.test(html)) {
    throw new Error(`${pageName}: relative URL remains in deployable HTML`);
  }
}

async function processHtml(relativePath, assetMap, runtimeUrl) {
  const sourcePath = path.join(sourceDir, relativePath);
  let html = await readFile(sourcePath, 'utf8');
  const pageName = path.basename(relativePath, '.html');
  const cssRules = new Map();
  const eventBindings = [];
  let inlineScriptIndex = 0;
  const scriptReplacements = [];

  html = html
    .replace(/\s*<link[^>]+href=["']\/?csp-compat\.css["'][^>]*>\s*/gi, '\n')
    .replace(/\s*<script[^>]+src=["']\/?js\/csp-events\.js["'][^>]*><\/script>\s*/gi, '\n');

  const inlineCss = [];
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css) => {
    inlineCss.push(css.trim());
    return '';
  });

  html = html.replace(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (_match, javascript) => {
    const token = `__PRIMEPROP_INLINE_SCRIPT_${inlineScriptIndex++}__`;
    scriptReplacements.push({ token, javascript });
    return token;
  });

  html = compileStaticTagAttributes(html, pageName, cssRules, eventBindings);
  html = rewriteHtmlReferences(html, assetMap);
  html = rewriteKnownPageUrls(html);

  for (const { token, javascript } of scriptReplacements) {
    const transformed = transformJavaScript(javascript.trim(), `${relativePath}:inline-script`);
    const scriptUrl = await emitAsset(`generated/${pageName}-inline-${shortHash(token)}.js`, transformed);
    html = html.replace(token, `<script src="${scriptUrl}"></script>`);
  }

  const generatedCss = [
    ...inlineCss,
    ...[...cssRules.entries()].map(([className, declaration]) => `.${className}{${declaration}}`),
  ].filter(Boolean).join('\n\n');

  if (generatedCss) {
    const cssUrl = await emitAsset(`generated/${pageName}.css`, generatedCss);
    html = html.replace(/<\/head>/i, `  <link rel="stylesheet" href="${cssUrl}">\n</head>`);
  }

  const eventsSource = staticEventScript(eventBindings);
  if (eventsSource) {
    const eventsUrl = await emitAsset(`generated/${pageName}-events.js`, transformJavaScript(eventsSource, `${relativePath}:events`));
    html = html.replace(/<\/body>/i, `  <script src="${eventsUrl}"></script>\n</body>`);
  }

  if (!html.includes(runtimeUrl)) {
    html = html.replace(/<\/head>/i, `  <script src="${runtimeUrl}"></script>\n</head>`);
  }

  const buildId = shortHash(html);
  if (/<meta\s+name=["']primeprop-build["']/i.test(html)) {
    html = html.replace(/<meta\s+name=["']primeprop-build["'][^>]*>/i, `<meta name="primeprop-build" content="${buildId}">`);
  } else {
    html = html.replace(/<head>/i, `<head>\n    <meta name="primeprop-build" content="${buildId}">`);
  }

  assertStrictHtml(html, relativePath);
  const outputPath = path.join(outputDir, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  return { relativePath, buildId };
}

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(assetsDir, { recursive: true });

  const files = await walk(sourceDir);
  const assetMap = new Map();

  for (const relativePath of files) {
    if (OMITTED_SOURCE_FILES.has(relativePath) || relativePath.endsWith('.html')) continue;
    const sourcePath = path.join(sourceDir, relativePath);
    const extension = path.extname(relativePath).toLowerCase();

    if (extension === '.js') {
      const transformed = transformJavaScript(await readFile(sourcePath, 'utf8'), relativePath);
      assetMap.set(relativePath, await emitAsset(relativePath, transformed));
      continue;
    }

    if (extension === '.css') {
      const css = await readFile(sourcePath, 'utf8');
      assetMap.set(relativePath, await emitAsset(relativePath, css));
      continue;
    }

    const outputPath = path.join(outputDir, relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await copyFile(sourcePath, outputPath);
    assetMap.set(relativePath, `/${relativePath}`);
  }

  const runtimeUrl = assetMap.get('js/strict-runtime.js');
  if (!runtimeUrl) throw new Error('strict runtime was not emitted');

  const pages = [];
  for (const relativePath of files.filter(file => file.endsWith('.html'))) {
    pages.push(await processHtml(relativePath, assetMap, runtimeUrl));
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceDirectory: 'public',
    outputDirectory: 'dist-public',
    runtime: runtimeUrl,
    assets: Object.fromEntries([...assetMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
    pages,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(outputDir, 'asset-manifest.json'), manifestText, 'utf8');

  console.log(JSON.stringify({
    event: 'strict_public_build_completed',
    pages: pages.length,
    assets: assetMap.size,
    manifestHash: shortHash(manifestText),
  }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
