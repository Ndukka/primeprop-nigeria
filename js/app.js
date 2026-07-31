/* ==========================================================================
   PrimeProp Nigeria — Shared App Logic
   All listing rendering, search, and navigation — zero hardcoded values.
   ========================================================================== */

const API_BASE = '/api/listings';

/* ── Helpers ─────────────────────────────────────────────── */
function formatPrice(n) { return '₦' + Number(n).toLocaleString(); }
function esc(str) { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function getQueryParam(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

function getFeatures(listing) {
  const f = [];
  if (listing.bedrooms > 0) f.push({ icon: 'fa-bed', label: listing.bedrooms + (listing.type==='sale' && listing.bedrooms>3 ? '+1' : '') + ' Beds' });
  if (listing.bathrooms > 0) f.push({ icon: 'fa-bath', label: listing.bathrooms + ' Baths' });
  if (listing.sqft > 0) {
    if (listing.type === 'land') f.push({ icon: 'fa-maximize', label: listing.sqft + ' SQM' });
    else f.push({ icon: 'fa-ruler-combined', label: listing.sqft.toLocaleString() + ' sqft' });
  }
  if (listing.parking > 0) f.push({ icon: 'fa-car', label: listing.parking + ' Parking' });
  return f;
}

/* ── API ─────────────────────────────────────────────────── */
async function fetchListings(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined && v !== 'all') params.set(k, v); });
  try {
    const res = await fetch(API_BASE + '?' + params.toString());
    const data = await res.json();
    return data.success ? data.data : [];
  } catch (err) { console.error('Fetch error:', err); return []; }
}

async function fetchListing(id) {
  try {
    const res = await fetch(API_BASE + '/' + id);
    const data = await res.json();
    return data.success ? data.data : null;
  } catch (err) { console.error('Fetch error:', err); return null; }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    return data.success ? data.data : null;
  } catch (err) { return null; }
}

/* ── Card Renderer ───────────────────────────────────────── */
function renderPropertyCard(listing) {
  const rawImg = (listing.images && listing.images.length > 0) ? listing.images[0] : '';
  const img = typeof rawImg === 'string' ? rawImg : (rawImg?.url || '');
  const tagClass = listing.type === 'rent' ? 'rent' : listing.type === 'sale' ? 'sale' : 'land';
  const tagLabel = listing.type === 'rent' ? 'For Rent' : listing.type === 'sale' ? 'For Sale' : 'Land';
  const features = getFeatures(listing);
  const badgeHTML = listing.badge ? `<span class="card-badge card-badge-${listing.badge.toLowerCase().replace(/\s/g,'-')}">${esc(listing.badge)}</span>` : '';
  const verifiedHTML = listing.verified ? `<span class="verified-badge-inline" title="Verified Property"><i class="fa-solid fa-circle-check"></i> Verified</span>` : '';
  const detailUrl = `listing-detail.html?id=${listing.id}`;

  return `
    <div class="property-card animate-in">
      <a href="${detailUrl}" class="property-card-img">
        <img src="${esc(img)}" alt="${esc(listing.title)}" onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg, #e2e8f0 0%, #f1f5f9 100%)';this.parentElement.innerHTML+='<i class=\\'fa-solid fa-image\\' style=\\'font-size:3rem;color:#94a3b8;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)\\'>'">
        ${badgeHTML}
        <span class="tag ${tagClass}">${tagLabel}</span>
        <button class="fav-btn" aria-label="Save" onclick="event.preventDefault();event.stopPropagation();this.querySelector('i').classList.toggle('fa-regular');this.querySelector('i').classList.toggle('fa-solid');this.querySelector('i').style.color=this.querySelector('i').classList.contains('fa-solid')?'#dc2626':''"><i class="fa-regular fa-heart"></i></button>
      </a>
      <div class="property-card-body">
        <div class="price-row">
          <span class="price">${formatPrice(listing.price)}${listing.priceUnit ? ' <small>' + esc(listing.priceUnit) + '</small>' : ''}</span>
          ${verifiedHTML}
        </div>
        <a href="${detailUrl}" class="title-link">${esc(listing.title)}</a>
        <div class="location"><i class="fa-solid fa-location-dot"></i> ${esc(listing.location)}</div>
        <div class="property-card-features">
          ${features.map(f => `<span class="feature"><i class="fa-solid ${f.icon}"></i> ${esc(f.label)}</span>`).join('')}
        </div>
        <div class="property-card-actions">
          <a href="${detailUrl}" class="btn btn-outline btn-sm">Details</a>
          <a href="https://wa.me/${esc(listing.agent?.phone || '2348000000000')}?text=${encodeURIComponent('Hello, I\'m interested in ' + listing.title + ' in ' + listing.location + '. Is it still available?')}" class="btn btn-whatsapp btn-sm" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> Chat</a>
        </div>
      </div>
    </div>`;
}

function renderCards(listings, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (listings.length === 0) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon"><i class="fa-solid fa-magnifying-glass"></i></div><h3>No listings found</h3><p>Try adjusting your search or browse all properties.</p><a href="properties.html" class="btn btn-primary">Browse All</a></div>`;
    return;
  }
  container.innerHTML = listings.map(renderPropertyCard).join('');
}

/* ── Search / Filter ─────────────────────────────────────── */
function setupListingPage(defaultType) {
  const cardsGrid = document.getElementById('cardsGrid');
  const resultsCount = document.getElementById('resultsCount');
  const sortSelect = document.getElementById('sortSelect');
  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');
  const clearBtn = document.getElementById('clearSearch');
  const typeSelect = document.getElementById('typeSelect');
  const purposeSelect = document.getElementById('purposeSelect');
  const sizeBtns = document.querySelectorAll('.filter-tag-btn[data-size]');
  const priceMin = document.getElementById('priceMin');
  const priceMax = document.getElementById('priceMax');

  let allData = [];
  let activeSize = null;
  let activeBedrooms = null;
  let currentPage = 1;
  const pageLimit = 9;
  const propertyTypeSelect = document.getElementById('propertyTypeSelect');
  const bedroomBtns = document.querySelectorAll('.filter-tag-btn[data-bedrooms]');
  const paginationContainer = document.getElementById('pagination');

  /* ── Fuzzy word matching ──────────────────────────────── */
  function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const m = [];
    for (let i = 0; i <= b.length; i++) { m[i] = [i]; }
    for (let j = 0; j <= a.length; j++) { m[0][j] = j; }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        m[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
          ? m[i - 1][j - 1]
          : Math.min(m[i - 1][j - 1] + 1, Math.min(m[i][j - 1] + 1, m[i - 1][j] + 1));
      }
    }
    return m[b.length][a.length];
  }

  function fuzzyWordMatch(queryWord, targetWord) {
    // Exact or prefix match is best
    if (targetWord.startsWith(queryWord)) return true;
    if (targetWord.includes(queryWord)) return true;
    // Short queries: allow 1 char difference
    if (queryWord.length <= 3) return levenshtein(queryWord, targetWord) <= 1;
    // Medium queries: allow 2 char difference
    if (queryWord.length <= 6) return levenshtein(queryWord, targetWord) <= 2;
    // Longer queries: proportional tolerance
    return levenshtein(queryWord, targetWord) <= Math.max(2, Math.floor(queryWord.length * 0.35));
  }

  function fuzzyTextMatch(query, text) {
    if (!query || !text) return false;
    const qLower = query.toLowerCase().trim();
    const tLower = text.toLowerCase();
    // First try substring (fast path for exact/partial matches)
    if (tLower.includes(qLower)) return true;
    // If query is purely numeric, only exact substring match (no fuzzy for numbers)
    if (/^\d+$/.test(qLower)) return false;
    // Split into words and try fuzzy matching each query word
    const queryWords = qLower.split(/\s+/).filter(w => w.length > 0);
    const targetWords = tLower.split(/\s+/).filter(w => w.length > 0);
    // Every query word must have at least one fuzzy match in the target
    return queryWords.every(qw => {
      // Numeric query words: exact substring only
      if (/^\d+$/.test(qw)) return tLower.includes(qw);
      return targetWords.some(tw => fuzzyWordMatch(qw, tw)) || tLower.includes(qw);
    });
  }

  function applyFilters() {
    let filtered = [...allData];
    const q = (searchInput && searchInput.value.trim().toLowerCase()) || '';

    // Fuzzy text search — matches title, location, area, city, description, price, sqft, amenities
    if (q) {
      filtered = filtered.filter(l => {
        const searchable = [
          l.title, l.location, l.area, l.city, l.description,
          String(l.price), String(l.sqft), '₦' + l.price.toLocaleString(),
          ...(l.amenities || [])
        ].join(' ');
        return fuzzyTextMatch(q, searchable);
      });
    }

    // Type filter
    if (typeSelect && typeSelect.value !== 'all') {
      filtered = filtered.filter(l => l.type === typeSelect.value);
    }
    if (purposeSelect && purposeSelect.value !== 'all') {
      filtered = filtered.filter(l => l.type === purposeSelect.value);
    }

    // Property type filter (apartment, duplex, etc.)
    if (propertyTypeSelect && propertyTypeSelect.value !== '' && propertyTypeSelect.value !== 'all' && propertyTypeSelect.value !== 'Any type') {
      const pt = propertyTypeSelect.value.toLowerCase();
      filtered = filtered.filter(l => {
        const lt = (l.propertyType || '').toLowerCase();
        return lt.includes(pt) || (pt === 'apartment / flat' && lt === 'apartment');
      });
    }

    // Bedroom filter
    if (activeBedrooms !== null && activeBedrooms !== '') {
      if (activeBedrooms === '5+') {
        filtered = filtered.filter(l => l.bedrooms >= 5);
      } else {
        const n = parseInt(activeBedrooms);
        if (!isNaN(n)) filtered = filtered.filter(l => l.bedrooms === n);
      }
    }

    // Size filter (land sqm)
    if (activeSize) {
      const minSqft = parseInt(activeSize);
      filtered = filtered.filter(l => l.sqft >= minSqft);
    }

    // Price range
    if (priceMin && priceMin.value) filtered = filtered.filter(l => l.price >= Number(priceMin.value));
    if (priceMax && priceMax.value) filtered = filtered.filter(l => l.price <= Number(priceMax.value));

    // Sort
    const sort = sortSelect ? sortSelect.value : 'featured';
    if (sort === 'price-asc') filtered.sort((a, b) => a.price - b.price);
    else if (sort === 'price-desc') filtered.sort((a, b) => b.price - a.price);
    else if (sort === 'newest') filtered.sort((a, b) => b.id - a.id);
    else filtered.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || b.id - a.id);

    // Pagination
    const totalResults = filtered.length;
    const totalPages = Math.ceil(totalResults / pageLimit) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * pageLimit;
    const paged = filtered.slice(start, start + pageLimit);

    renderCards(paged, 'cardsGrid');
    renderPagination(currentPage, totalPages, totalResults);
  }

  // Load all data for this page type
  async function load() {
    const filters = {};
    if (defaultType && defaultType !== 'all') filters.type = defaultType;
    // If type selector exists, use its value
    if (typeSelect && typeSelect.value && typeSelect.value !== 'all') filters.type = typeSelect.value;
    allData = await fetchListings(filters);
    
    // Read URL query params for pre-filled search (from areas.html links + homepage form)
    const urlSearch = getQueryParam('search');
    const urlLocation = getQueryParam('location');
    const urlType = getQueryParam('type');
    const urlPrice = getQueryParam('price');
    
    if (urlSearch && searchInput && !searchInput.value) {
      searchInput.value = decodeURIComponent(urlSearch);
    }
    // Handle homepage search form params
    if (urlLocation && searchInput && !searchInput.value) {
      searchInput.value = decodeURIComponent(urlLocation);
    }
    if (urlType && typeSelect && urlType !== 'Any Type') {
      const t = urlType.toLowerCase();
      if (t.includes('rent')) typeSelect.value = 'rent';
      else if (t.includes('sale') || t.includes('buy')) typeSelect.value = 'sale';
      else if (t.includes('land')) typeSelect.value = 'land';
    }
    if (urlPrice && priceMin && priceMax && !priceMin.value) {
      // Parse price ranges like "₦500k - ₦5M" or "₦5M - ₦20M"
      const nums = urlPrice.replace(/[₦,]/g, '').match(/(\d+)\s*[kKmM]?/gi);
      if (nums && nums.length >= 2) {
        const toNum = (s) => { s = s.toUpperCase(); return s.endsWith('K') ? parseInt(s)*1000 : s.endsWith('M') ? parseInt(s)*1000000 : parseInt(s); };
        priceMin.value = toNum(nums[0]);
        priceMax.value = toNum(nums[1]);
      }
    }

    currentPage = 1;
    applyFilters();
    updateStats();
  }

  async function updateStats() {
    const stats = await fetchStats();
    if (!stats) return;
    // Update count badges on the page
    document.querySelectorAll('.count[data-type]').forEach(el => {
      const t = el.getAttribute('data-type');
      if (t && stats[t] !== undefined) el.textContent = stats[t] + '+ listings';
    });
  }

  // Event listeners
  if (searchBtn) searchBtn.addEventListener('click', applyFilters);
  if (searchInput) {
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); currentPage = 1; applyFilters(); } });
    searchInput.addEventListener('input', () => { currentPage = 1; applyFilters(); });
  }
  if (sortSelect) sortSelect.addEventListener('change', () => { currentPage = 1; applyFilters(); });
  if (typeSelect) typeSelect.addEventListener('change', load);
  if (purposeSelect) purposeSelect.addEventListener('change', load);
  if (clearBtn) {
    clearBtn.addEventListener('click', e => {
      e.preventDefault();
      if (searchInput) searchInput.value = '';
      if (typeSelect) typeSelect.value = 'all';
      if (purposeSelect) purposeSelect.value = defaultType || 'all';
      activeSize = null;
      activeBedrooms = null;
      currentPage = 1;
      if (sizeBtns) sizeBtns.forEach(b => b.classList.remove('active'));
      if (sizeBtns && sizeBtns.length > 0) sizeBtns[0].classList.add('active');
      if (bedroomBtns) bedroomBtns.forEach(b => b.classList.remove('active'));
      if (bedroomBtns && bedroomBtns.length > 0) bedroomBtns[0].classList.add('active');
      if (priceMin) priceMin.value = '';
      if (priceMax) priceMax.value = '';
      load();
    });
  }

  // Size buttons
  if (sizeBtns) {
    sizeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        sizeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSize = btn.getAttribute('data-size');
        applyFilters();
      });
    });
  }

  // Bedroom buttons
  if (bedroomBtns) {
    bedroomBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        bedroomBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeBedrooms = btn.getAttribute('data-bedrooms');
        applyFilters();
      });
    });
  }

  // Price range inputs
  if (priceMin) priceMin.addEventListener('input', applyFilters);
  if (priceMax) priceMax.addEventListener('input', applyFilters);

  load();

  // Expose for pagination buttons
  window.__ppGoTo = (p) => { currentPage = p; applyFilters(); const grid = document.getElementById('cardsGrid'); if (grid) window.scrollTo({ top: grid.offsetTop - 100, behavior: 'smooth' }); };
}

/* ── Pagination Renderer ────────────────────────────────── */
function renderPagination(page, totalPages, totalResults) {
  const resultsEl = document.getElementById('resultsCount');
  if (resultsEl) {
    resultsEl.textContent = totalResults + ' listing' + (totalResults !== 1 ? 's' : '') + ' found';
  }

  const container = document.getElementById('pagination');
  if (!container) return;
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let html = '<div class="pagination-bar">';
  html += `<span class="pg-info">Page ${page} of ${totalPages} (${totalResults} total)</span>`;
  html += '<div class="pg-btns">';
  if (page > 1) {
    html += `<button class="btn btn-outline btn-sm pg-btn" onclick="window.__ppGoTo(${page - 1})"><i class="fa-solid fa-chevron-left"></i> Prev</button>`;
  } else {
    html += `<span class="btn btn-outline btn-sm pg-btn pg-disabled"><i class="fa-solid fa-chevron-left"></i> Prev</span>`;
  }

  const maxButtons = 5;
  let startP = Math.max(1, page - Math.floor(maxButtons / 2));
  let endP = Math.min(totalPages, startP + maxButtons - 1);
  if (endP - startP < maxButtons - 1) startP = Math.max(1, endP - maxButtons + 1);

  for (let i = startP; i <= endP; i++) {
    html += `<button class="btn btn-sm pg-num ${i === page ? 'pg-active' : 'btn-outline'}" onclick="window.__ppGoTo(${i})">${i}</button>`;
  }

  if (page < totalPages) {
    html += `<button class="btn btn-outline btn-sm pg-btn" onclick="window.__ppGoTo(${page + 1})">Next <i class="fa-solid fa-chevron-right"></i></button>`;
  } else {
    html += `<span class="btn btn-outline btn-sm pg-btn pg-disabled">Next <i class="fa-solid fa-chevron-right"></i></span>`;
  }
  html += '</div></div>';
  container.innerHTML = html;
}

/* ── Detail Page ─────────────────────────────────────────── */
async function loadDetailPage() {
  const id = getQueryParam('id');
  if (!id) {
    document.getElementById('detailContent').innerHTML = '<div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-circle-exclamation"></i></div><h3>No listing specified</h3><p>Please select a property to view details.</p><a href="properties.html" class="btn btn-primary">Browse Properties</a></div>';
    return;
  }

  const listing = await fetchListing(id);
  if (!listing) {
    document.getElementById('detailContent').innerHTML = '<div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-circle-exclamation"></i></div><h3>Listing not found</h3><p>This property may have been removed or is no longer available.</p><a href="properties.html" class="btn btn-primary">Browse Properties</a></div>';
    return;
  }

  renderDetailPage(listing);
  loadSimilarListings(listing);
}

function renderDetailPage(listing) {
  const features = getFeatures(listing);
  // Support both legacy plain strings and new {url, type} objects
  const rawImages = listing.images && listing.images.length > 0 ? listing.images : [''];
  const images = rawImages.map(function(img) { return typeof img === 'string' ? { url: img, type: 'image' } : img; });
  const imageUrls = images.map(function(i) { return i.url; });

  // Helper to render a gallery slide based on media type
  function renderSlide(img, i) {
    const prevIdx = (i - 1 + images.length) % images.length;
    const nextIdx = (i + 1) % images.length;
    const arrows = `
      <a href="#g${prevIdx+1}" class="gal-arrow gal-prev" aria-label="Previous"><i class="fa-solid fa-chevron-left"></i></a>
      <a href="#g${nextIdx+1}" class="gal-arrow gal-next" aria-label="Next"><i class="fa-solid fa-chevron-right"></i></a>`;

    if (img.type === 'video') {
      return `<div class="gallery-slide" id="g${i+1}">
        <video src="${esc(img.url)}" controls preload="metadata" style="width:100%;height:380px;object-fit:cover;background:#000;" onclick="event.stopPropagation()">
          Your browser does not support video playback.
        </video>${arrows}</div>`;
    }
    if (img.type === 'pdf') {
      return `<div class="gallery-slide" id="g${i+1}">
        <div style="width:100%;height:380px;display:flex;align-items:center;justify-content:center;background:#f8fafc;flex-direction:column;gap:12px;">
          <i class="fa-solid fa-file-pdf" style="font-size:4rem;color:#dc2626;"></i>
          <a href="${esc(img.url)}" target="_blank" class="btn btn-outline btn-sm"><i class="fa-solid fa-download"></i> View Document</a>
        </div>${arrows}</div>`;
    }
    // Default: image
    return `<div class="gallery-slide" id="g${i+1}">
      <img src="${esc(img.url)}" alt="${esc(listing.title)} — ${i+1}" onclick="openLightbox(${JSON.stringify(imageUrls).replace(/"/g,'&quot;')}, ${i})" style="cursor:pointer" onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg,#e2e8f0 0%,#f1f5f9 100%)';this.parentElement.style.minHeight='380px'">
      ${arrows}</div>`;
  }

  let galleryHTML = '';
  if (images.length > 1) {
    const slides = images.map(renderSlide).join('');
    const dots = images.map((_, i) => {
      const icon = _.type === 'video' ? 'fa-play' : _.type === 'pdf' ? 'fa-file-pdf' : 'fa-image';
      return `<a href="#g${i+1}" aria-label="View item ${i+1}" title="${_.type}"><i class="fa-solid ${icon}"></i></a>`;
    }).join('');
    galleryHTML = `<div class="gallery"><div class="gallery-track">${slides}</div><div class="gallery-dots">${dots}</div></div>`;
  } else {
    const img = images[0];
    if (img.type === 'video') {
      galleryHTML = `<div class="detail-img-large"><video src="${esc(img.url)}" controls preload="metadata" style="width:100%;height:380px;object-fit:cover;background:#000;"></video></div>`;
    } else if (img.type === 'pdf') {
      galleryHTML = `<div class="detail-img-large" style="display:flex;align-items:center;justify-content:center;background:#f8fafc;flex-direction:column;gap:12px;"><i class="fa-solid fa-file-pdf" style="font-size:5rem;color:#dc2626;"></i><a href="${esc(img.url)}" target="_blank" class="btn btn-outline">View Document</a></div>`;
    } else {
      galleryHTML = `<div class="detail-img-large"><img src="${esc(img.url)}" alt="${esc(listing.title)}" onclick="openLightbox(${JSON.stringify(imageUrls).replace(/"/g,'&quot;')}, 0)" style="width:100%;height:380px;object-fit:cover;cursor:pointer" onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg,#e2e8f0 0%,#f1f5f9 100%)';this.parentElement.innerHTML+='<i class=\\'fa-solid fa-image\\' style=\\'font-size:5rem;color:#94a3b8;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)\\'>'"></div>`;
    }
  }

  // Features row
  const featuresHTML = features.map(f => 
    `<div class="df"><i class="fa-solid ${f.icon}"></i> <strong>${esc(f.label)}</strong></div>`
  ).join('');

  // Amenities
  const amenitiesHTML = (listing.amenities || []).map(a =>
    `<div class="am"><i class="fa-solid fa-check"></i> ${esc(a)}</div>`
  ).join('');

  // Type tag
  const tagClass = listing.type === 'rent' ? 'rent' : listing.type === 'sale' ? 'sale' : 'land';
  const tagLabel = listing.type === 'rent' ? 'For Rent' : listing.type === 'sale' ? 'For Sale' : 'Land';
  const verifiedBadge = listing.verified ? `<span class="detail-verified"><i class="fa-solid fa-circle-check"></i> Verified Property</span>` : '';

  // Move-in cost estimate (for rent)
  let moveInHTML = '';
  if (listing.type === 'rent' && listing.moveInCosts) {
    moveInHTML = `
      <div style="background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-top: 20px;">
        <h4 style="font-size: 0.9rem; font-weight: 700; color: var(--heading); margin-bottom: 12px;">Move-in Cost Estimate</h4>
        <div style="display: flex; justify-content: space-between; font-size: 0.88rem; padding: 8px 0; border-bottom: 1px solid var(--border-light);"><span>Annual Rent</span><strong>${formatPrice(listing.moveInCosts.annualRent)}</strong></div>
        <div style="display: flex; justify-content: space-between; font-size: 0.88rem; padding: 8px 0; border-bottom: 1px solid var(--border-light);"><span>Agency Fee (10%)</span><strong>${formatPrice(listing.moveInCosts.agencyFee)}</strong></div>
        <div style="display: flex; justify-content: space-between; font-size: 0.88rem; padding: 8px 0; border-bottom: 1px solid var(--border-light);"><span>Security Deposit</span><strong>${formatPrice(listing.moveInCosts.securityDeposit)}</strong></div>
        <div style="display: flex; justify-content: space-between; font-size: 0.88rem; padding: 8px 0; border-bottom: 1px solid var(--border-light);"><span>Service Charge</span><strong>${formatPrice(listing.moveInCosts.serviceCharge)}</strong></div>
        <div style="display: flex; justify-content: space-between; font-size: 0.95rem; padding: 10px 0; font-weight: 700; color: var(--heading); margin-top: 4px;"><span>Total Move-in</span><strong>${formatPrice(listing.moveInCosts.total)}</strong></div>
      </div>`;
  }
  
  // Agent avatar (image or initials fallback)
  const agentAvatarHTML = listing.agent?.avatar 
    ? `<img src="${esc(listing.agent.avatar)}" class="agent-avatar-img" alt="${esc(listing.agent.name)}">`
    : `<div class="agent-avatar">${esc(listing.agent?.initials || 'PA')}</div>`;

  // Build description paragraphs
  const paras = (listing.description || '').split('\n\n').filter(p => p.trim()).map(p => `<p>${esc(p.trim())}</p>`).join('\n');

  const html = `
    <div class="detail-grid">
      <div class="detail-main">
        ${galleryHTML}
        <div class="detail-content">
          <span class="tag ${tagClass}" style="display: inline-block; margin-bottom: 12px;">${tagLabel}</span>
          ${verifiedBadge}
          <div class="d-price">${formatPrice(listing.price)}${listing.priceUnit ? ' <small>' + esc(listing.priceUnit) + '</small>' : ''}</div>
          <div class="d-title">${esc(listing.title)}</div>
          <div class="d-loc"><i class="fa-solid fa-location-dot"></i> ${esc(listing.location)}</div>
          <div class="d-features">
            ${featuresHTML}
            <div class="df"><i class="fa-solid fa-calendar-check"></i> Available <strong>${esc(listing.availability || 'Immediately')}</strong></div>
          </div>
          <div class="d-desc">${paras}</div>
          ${(listing.amenities && listing.amenities.length > 0) ? `
          <h4 style="font-size: 1rem; font-weight: 700; color: var(--heading); margin-bottom: 12px;">Amenities</h4>
          <div class="d-amenities">${amenitiesHTML}</div>` : ''}
        </div>
      </div>
      <div class="detail-sidebar">
        <div class="detail-contact-card">
          ${agentAvatarHTML}
          <h3>${esc(listing.agent?.name || 'PrimeProp Agent')}</h3>
          <p class="agent-role">${esc(listing.agent?.role || 'Agent')}</p>
          <a href="https://wa.me/${esc(listing.agent?.phone || '2348000000000')}?text=${encodeURIComponent('Hello, I\'m interested in ' + listing.title + ' (' + formatPrice(listing.price) + '). Is it still available? I\'d like to schedule an inspection.')}" class="btn btn-whatsapp" style="width:100%;justify-content:center;padding:12px;font-size:0.95rem;" target="_blank" rel="noopener">
            <i class="fa-brands fa-whatsapp"></i> Chat on WhatsApp
          </a>
          <a href="tel:+${esc(listing.agent?.phone || '2348000000000')}" class="btn btn-outline" style="width:100%;justify-content:center;">
            <i class="fa-solid fa-phone"></i> Call Agent
          </a>
          <p class="contact-note"><i class="fa-solid fa-shield-halved"></i> Verify all details independently before making any payment.</p>
        </div>
        <div class="detail-safety-card">
          <h4><i class="fa-solid fa-triangle-exclamation"></i> Before you ${listing.type === 'rent' ? 'pay rent' : listing.type === 'sale' ? 'buy' : 'purchase land'}:</h4>
          <ul>
            <li><i class="fa-solid fa-circle"></i> Confirm the property is still available</li>
            <li><i class="fa-solid fa-circle"></i> Inspect the property in person</li>
            <li><i class="fa-solid fa-circle"></i> Verify the agent's authority</li>
            <li><i class="fa-solid fa-circle"></i> Review all documents independently</li>
            <li><i class="fa-solid fa-circle"></i> Get a receipt for every payment</li>
          </ul>
        </div>
        ${moveInHTML}
      </div>
    </div>`;

  document.getElementById('detailContent').innerHTML = html;
}

async function loadSimilarListings(listing) {
  const container = document.getElementById('similarSection');
  if (!container) return;

  // SMART similar: tiered fallback to always show 3 suggestions
  // Tier 1: same type + same city (exclude current)
  let similar = await fetchListings({ type: listing.type, city: listing.city });
  similar = similar.filter(l => l.id !== listing.id);

  // Tier 2: if not enough, add same type from other cities
  if (similar.length < 3) {
    const existingIds = new Set(similar.map(l => l.id));
    existingIds.add(listing.id);
    const more = await fetchListings({ type: listing.type });
    const extra = more.filter(l => !existingIds.has(l.id));
    // Sort extra by closest price to current listing
    extra.sort((a, b) => Math.abs(a.price - listing.price) - Math.abs(b.price - listing.price));
    const needed = 3 - similar.length;
    similar = similar.concat(extra.slice(0, needed));
  }

  // Tier 3: if still not enough, add same city from other types
  if (similar.length < 3) {
    const existingIds = new Set(similar.map(l => l.id));
    existingIds.add(listing.id);
    const more = await fetchListings({ city: listing.city });
    const extra = more.filter(l => !existingIds.has(l.id));
    extra.sort((a, b) => Math.abs(a.price - listing.price) - Math.abs(b.price - listing.price));
    const needed = 3 - similar.length;
    similar = similar.concat(extra.slice(0, needed));
  }

  // Tier 4: if still not enough, just grab any listings
  if (similar.length < 3) {
    const existingIds = new Set(similar.map(l => l.id));
    existingIds.add(listing.id);
    const more = await fetchListings();
    const extra = more.filter(l => !existingIds.has(l.id));
    extra.sort((a, b) => Math.abs(a.price - listing.price) - Math.abs(b.price - listing.price));
    const needed = 3 - similar.length;
    similar = similar.concat(extra.slice(0, needed));
  }

  const filtered = similar.slice(0, 3);

  if (filtered.length === 0) {
    container.style.display = 'none';
    return;
  }

  const typeLabel = listing.type === 'rent' ? 'rental' : listing.type === 'sale' ? 'sale' : 'land';
  const typeLink = listing.type === 'rent' ? 'properties-rent.html' : listing.type === 'sale' ? 'properties-sale.html' : 'properties-land.html';

  container.innerHTML = `
    <div class="section-header-between">
      <h2 style="font-size: 1.3rem;">Similar ${typeLabel} properties</h2>
      <a href="${typeLink}" class="view-all">View all ${typeLabel}s <i class="fa-solid fa-arrow-right"></i></a>
    </div>
    <div class="listings-grid" id="similarGrid"></div>`;

  renderCards(filtered, 'similarGrid');
}

/* ── Homepage Featured ───────────────────────────────────── */
async function loadFeaturedProperties() {
  const container = document.getElementById('featuredCards');
  if (!container) return;
  const featured = await fetchListings({ featured: 'true' });
  if (featured.length === 0) {
    container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:40px;">No featured properties at the moment.</p>';
    return;
  }
  container.innerHTML = featured.slice(0, 3).map(renderPropertyCard).join('');
}

/* ── Image Lightbox ─────────────────────────────────────── */
let lightboxState = { images: [], index: 0, zoom: 1, panX: 0, panY: 0, dragging: false, dragStartX: 0, dragStartY: 0, lastTap: 0 };

function openLightbox(images, startIndex) {
  if (!images || images.length === 0) return;

  // Create lightbox if not in DOM
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox-overlay';
    lb.innerHTML = `
      <button class="lb-close" aria-label="Close gallery">&times;</button>
      <button class="lb-nav lb-prev" aria-label="Previous image"><i class="fa-solid fa-chevron-left"></i></button>
      <button class="lb-nav lb-next" aria-label="Next image"><i class="fa-solid fa-chevron-right"></i></button>
      <div class="lb-controls">
        <button class="lb-zoom-btn" data-zoom="out" aria-label="Zoom out"><i class="fa-solid fa-minus"></i></button>
        <span class="lb-zoom-level">100%</span>
        <button class="lb-zoom-btn" data-zoom="in" aria-label="Zoom in"><i class="fa-solid fa-plus"></i></button>
        <span class="lb-counter"></span>
      </div>
      <div class="lb-img-wrap">
        <img src="" alt="" id="lightboxImg">
      </div>`;
    document.body.appendChild(lb);

    // Event listeners
    lb.querySelector('.lb-close').addEventListener('click', closeLightbox);
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
    lb.querySelector('.lb-prev').addEventListener('click', () => lightboxNav(-1));
    lb.querySelector('.lb-next').addEventListener('click', () => lightboxNav(1));
    lb.querySelector('[data-zoom="in"]').addEventListener('click', () => lightboxZoom(0.25));
    lb.querySelector('[data-zoom="out"]').addEventListener('click', () => lightboxZoom(-0.25));

    const img = lb.querySelector('#lightboxImg');
    const imgWrap = lb.querySelector('.lb-img-wrap');

    // Mouse wheel zoom
    imgWrap.addEventListener('wheel', e => {
      e.preventDefault();
      lightboxZoom(e.deltaY < 0 ? 0.15 : -0.15);
    }, { passive: false });

    // Double-click zoom toggle
    img.addEventListener('click', e => {
      const now = Date.now();
      if (now - lightboxState.lastTap < 300) {
        e.preventDefault();
        lightboxState.zoom > 1 ? lightboxResetZoom() : lightboxZoomTo(2.5);
      }
      lightboxState.lastTap = now;
    });

    // Drag to pan
    img.addEventListener('mousedown', e => {
      if (lightboxState.zoom <= 1) return;
      e.preventDefault();
      lightboxState.dragging = true;
      lightboxState.dragStartX = e.clientX - lightboxState.panX;
      lightboxState.dragStartY = e.clientY - lightboxState.panY;
      img.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', e => {
      if (!lightboxState.dragging) return;
      lightboxState.panX = e.clientX - lightboxState.dragStartX;
      lightboxState.panY = e.clientY - lightboxState.dragStartY;
      applyLightboxTransform();
    });
    window.addEventListener('mouseup', () => {
      lightboxState.dragging = false;
      const img = document.getElementById('lightboxImg');
      if (img) img.style.cursor = lightboxState.zoom > 1 ? 'grab' : 'default';
    });

    // Touch swipe
    let touchStartX = 0, touchStartY = 0, touchStartDist = 0, touchStartZoom = 1;
    imgWrap.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        touchStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        touchStartZoom = lightboxState.zoom;
      }
    }, { passive: true });
    imgWrap.addEventListener('touchend', e => {
      if (lightboxState.zoom > 1) return;
      const dx = (e.changedTouches[0]?.clientX || 0) - touchStartX;
      const dy = (e.changedTouches[0]?.clientY || 0) - touchStartY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        lightboxNav(dx < 0 ? 1 : -1);
      }
    });
    imgWrap.addEventListener('touchmove', e => {
      if (e.touches.length === 2) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (touchStartDist > 0) {
          const scale = touchStartZoom * (dist / touchStartDist);
          lightboxState.zoom = Math.max(0.5, Math.min(5, scale));
          applyLightboxTransform();
        }
      }
    }, { passive: true });

    // Keyboard
    document.addEventListener('keydown', lightboxKeyHandler);
  }

  // Set state
  lightboxState.images = images;
  lightboxState.index = startIndex;
  lightboxState.zoom = 1;
  lightboxState.panX = 0;
  lightboxState.panY = 0;

  updateLightboxImage();
  lb.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function lightboxNav(dir) {
  lightboxState.index = (lightboxState.index + dir + lightboxState.images.length) % lightboxState.images.length;
  lightboxResetZoom();
  updateLightboxImage();
}

function lightboxZoom(delta) {
  lightboxZoomTo(Math.max(0.5, Math.min(5, lightboxState.zoom + delta)));
}

function lightboxZoomTo(level) {
  lightboxState.zoom = level;
  if (level <= 1) { lightboxState.panX = 0; lightboxState.panY = 0; }
  applyLightboxTransform();
}

function lightboxResetZoom() {
  lightboxState.zoom = 1;
  lightboxState.panX = 0;
  lightboxState.panY = 0;
  applyLightboxTransform();
}

function applyLightboxTransform() {
  const img = document.getElementById('lightboxImg');
  if (img) {
    img.style.transform = `translate(${lightboxState.panX}px, ${lightboxState.panY}px) scale(${lightboxState.zoom})`;
    img.style.cursor = lightboxState.zoom > 1 ? 'grab' : 'default';
  }
  const level = document.querySelector('.lb-zoom-level');
  if (level) level.textContent = Math.round(lightboxState.zoom * 100) + '%';
}

function updateLightboxImage() {
  const img = document.getElementById('lightboxImg');
  if (img) img.src = lightboxState.images[lightboxState.index];
  const counter = document.querySelector('.lb-counter');
  if (counter) counter.textContent = `${lightboxState.index + 1} / ${lightboxState.images.length}`;
  // Hide nav arrows if only 1 image
  document.querySelectorAll('.lb-nav').forEach(n => {
    n.style.display = lightboxState.images.length <= 1 ? 'none' : '';
  });
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (lb) lb.classList.remove('active');
  document.body.style.overflow = '';
  lightboxState.zoom = 1;
  lightboxState.panX = 0;
  lightboxState.panY = 0;
}

function lightboxKeyHandler(e) {
  const lb = document.getElementById('lightbox');
  if (!lb || !lb.classList.contains('active')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lightboxNav(-1);
  if (e.key === 'ArrowRight') lightboxNav(1);
  if (e.key === '+') lightboxZoom(0.25);
  if (e.key === '-') lightboxZoom(-0.25);
  if (e.key === '0') lightboxResetZoom();
}

/* ── Districts Loader (Areas Page) ──────────────────────── */
async function loadDistricts() {
  const container = document.getElementById('districtsGrid');
  if (!container) return;
  try {
    const res = await fetch('/api/districts');
    const data = await res.json();
    const districts = data.success ? data.data : [];
    if (districts.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No district guides available.</p></div>';
      return;
    }
    container.innerHTML = districts.map(d => {
      const linkPage = d.linkType === 'sale' ? 'properties-sale.html' : 'properties.html';
      const searchParam = '?search=' + encodeURIComponent(d.name);
      const href = linkPage + searchParam;
      return `
        <a href="${href}" class="district-card district-card-link" id="district-${d.id}">
          <div class="district-card-img"><img src="${esc(d.image)}" alt="${esc(d.name)}" onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg, #e2e8f0 0%, #f1f5f9 100%)'"></div>
          <div>
            <div class="district-meta"><span class="dot"></span> ${esc(d.name)} <span style="margin:0 6px;">•</span> ${esc(d.city)}</div>
            <h3>${esc(d.name)}</h3>
            <p>${esc(d.description)}</p>
            <div class="district-checks">
              ${(d.checks || []).map(c => `<div><i class="fa-solid fa-check"></i> ${esc(c)}</div>`).join('')}
            </div>
          </div>
          <div class="district-footer">
            <span>View properties <i class="fa-solid fa-arrow-right"></i></span>
          </div>
        </a>`;
    }).join('');
  } catch (err) {
    container.innerHTML = '<div class="empty-state"><p>Could not load district guides.</p></div>';
  }
}
