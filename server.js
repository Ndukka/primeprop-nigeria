const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data', 'listings.json');
const DISTRICTS_FILE = path.join(__dirname, 'data', 'districts.json');

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname)); // serve all static files (HTML, CSS, etc.)

// ── Helpers (Listings) ─────────────────────────────────────
function readListings() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading listings:', err.message);
    return [];
  }
}

function writeListings(listings) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(listings, null, 2), 'utf-8');
}

function getNextId(listings) {
  if (listings.length === 0) return 1;
  return Math.max(...listings.map(l => l.id)) + 1;
}

// ── Helpers (Districts) ────────────────────────────────────
function readDistricts() {
  try {
    const raw = fs.readFileSync(DISTRICTS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading districts:', err.message);
    return [];
  }
}

function writeDistricts(districts) {
  fs.writeFileSync(DISTRICTS_FILE, JSON.stringify(districts, null, 2), 'utf-8');
}

function getNextDistrictId(districts) {
  if (districts.length === 0) return 1;
  return Math.max(...districts.map(d => d.id)) + 1;
}

// ── API Routes: Listings ───────────────────────────────────

// GET /api/listings — get all listings (with optional filters + pagination)
app.get('/api/listings', (req, res) => {
  let listings = readListings();
  const { type, city, area, minPrice, maxPrice, bedrooms, search, featured, verified, sort } = req.query;

  // Filter by type (rent / sale / land)
  if (type && type !== 'all') {
    listings = listings.filter(l => l.type === type);
  }

  // Filter by city
  if (city) {
    listings = listings.filter(l => l.city.toLowerCase() === city.toLowerCase());
  }

  // Filter by area
  if (area) {
    listings = listings.filter(l => l.area.toLowerCase().includes(area.toLowerCase()));
  }

  // Filter by price range
  if (minPrice) {
    listings = listings.filter(l => l.price >= Number(minPrice));
  }
  if (maxPrice) {
    listings = listings.filter(l => l.price <= Number(maxPrice));
  }

  // Filter by bedrooms
  if (bedrooms) {
    listings = listings.filter(l => l.bedrooms >= Number(bedrooms));
  }

  // Filter by verified status
  if (verified === 'true') {
    listings = listings.filter(l => l.verified === true);
  } else if (verified === 'false') {
    listings = listings.filter(l => !l.verified);
  }

  // Search by keyword (title, location, description, price, sqft, amenities) — with fuzzy matching
  if (search) {
    const q = search.toLowerCase().trim();
    
    function lev(a, b) {
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

    function fuzzyMatch(queryWord, targetWord) {
      if (targetWord.startsWith(queryWord)) return true;
      if (targetWord.includes(queryWord)) return true;
      if (queryWord.length <= 3) return lev(queryWord, targetWord) <= 1;
      if (queryWord.length <= 6) return lev(queryWord, targetWord) <= 2;
      return lev(queryWord, targetWord) <= Math.max(2, Math.floor(queryWord.length * 0.35));
    }

    const queryWords = q.split(/\s+/).filter(w => w.length > 0);

    listings = listings.filter(l => {
      const searchable = [
        l.title, l.location, l.description, l.area, l.city,
        String(l.price), String(l.sqft), '₦' + l.price.toLocaleString(),
        ...(l.amenities || [])
      ].join(' ').toLowerCase();

      // Fast path: exact substring
      if (searchable.includes(q)) return true;
      
      // If query is purely numeric, only exact match (no fuzzy for numbers)
      if (/^\d+$/.test(q)) return false;

      // Fuzzy path: each query word must fuzzy-match at least one word in searchable
      const targetWords = searchable.split(/\s+/).filter(w => w.length > 0);
      return queryWords.every(qw => {
        // Numeric query words: exact substring only
        if (/^\d+$/.test(qw)) return searchable.includes(qw);
        return targetWords.some(tw => fuzzyMatch(qw, tw)) || searchable.includes(qw);
      });
    });
  }

  // Filter featured only
  if (featured === 'true') {
    listings = listings.filter(l => l.featured === true);
  }

  // Sort
  if (sort === 'price-asc') {
    listings.sort((a, b) => a.price - b.price);
  } else if (sort === 'price-desc') {
    listings.sort((a, b) => b.price - a.price);
  } else if (sort === 'newest') {
    listings.sort((a, b) => b.id - a.id);
  }

  // ── Pagination (only when explicitly requested) ────────
  const totalCount = listings.length;
  const hasPagination = req.query.page !== undefined || req.query.limit !== undefined;
  
  if (hasPagination) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 9);
    const totalPages = Math.ceil(totalCount / limit);
    const startIndex = (page - 1) * limit;
    const paginatedListings = listings.slice(startIndex, startIndex + limit);

    res.json({
      success: true,
      count: totalCount,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      data: paginatedListings
    });
  } else {
    res.json({ success: true, count: totalCount, data: listings });
  }
});

// GET /api/listings/:id — get a single listing
app.get('/api/listings/:id', (req, res) => {
  const listings = readListings();
  const listing = listings.find(l => l.id === Number(req.params.id));
  if (!listing) {
    return res.status(404).json({ success: false, message: 'Listing not found' });
  }
  res.json({ success: true, data: listing });
});

// POST /api/listings — create a new listing
app.post('/api/listings', (req, res) => {
  const listings = readListings();
  const { title, type, propertyType, price, priceDisplay, priceUnit, location, area, city,
          bedrooms, bathrooms, sqft, parking, description, amenities, images, agent,
          availability, featured, badge, moveInCosts, verified } = req.body;

  // Basic validation
  if (!title || !type || !price || !location) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: title, type, price, location'
    });
  }

  const newListing = {
    id: getNextId(listings),
    title,
    type: type || 'rent',
    propertyType: propertyType || 'apartment',
    price: Number(price),
    priceDisplay: priceDisplay || `₦${Number(price).toLocaleString()}`,
    priceUnit: priceUnit || (type === 'rent' ? '/ year' : ''),
    location,
    area: area || location.split(',')[0].trim(),
    city: city || 'Lagos',
    bedrooms: Number(bedrooms) || 0,
    bathrooms: Number(bathrooms) || 0,
    sqft: Number(sqft) || 0,
    parking: Number(parking) || 0,
    description: description || '',
    amenities: Array.isArray(amenities) ? amenities : [],
    images: Array.isArray(images) && images.length > 0 ? images : [
      'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=1200&q=80'
    ],
    agent: agent || { name: 'PrimeProp Agent', initials: 'PA', phone: '2348000000000', role: 'Agent' },
    availability: availability || 'Immediately',
    featured: Boolean(featured),
    badge: badge || '',
    moveInCosts: moveInCosts || null,
    verified: verified !== undefined ? Boolean(verified) : false,
    createdAt: new Date().toISOString()
  };

  listings.push(newListing);
  writeListings(listings);

  res.status(201).json({ success: true, data: newListing });
});

// PUT /api/listings/:id — update a listing
app.put('/api/listings/:id', (req, res) => {
  const listings = readListings();
  const index = listings.findIndex(l => l.id === Number(req.params.id));

  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Listing not found' });
  }

  // Merge existing with new data (preserve id, verified, and other fields)
  const updated = {
    ...listings[index],
    ...req.body,
    id: listings[index].id, // never change the id
    price: req.body.price ? Number(req.body.price) : listings[index].price,
    bedrooms: req.body.bedrooms !== undefined ? Number(req.body.bedrooms) : listings[index].bedrooms,
    bathrooms: req.body.bathrooms !== undefined ? Number(req.body.bathrooms) : listings[index].bathrooms,
    sqft: req.body.sqft !== undefined ? Number(req.body.sqft) : listings[index].sqft,
    parking: req.body.parking !== undefined ? Number(req.body.parking) : listings[index].parking,
    featured: req.body.featured !== undefined ? Boolean(req.body.featured) : listings[index].featured,
    verified: req.body.verified !== undefined ? Boolean(req.body.verified) : listings[index].verified,
    updatedAt: new Date().toISOString()
  };

  listings[index] = updated;
  writeListings(listings);

  res.json({ success: true, data: updated });
});

// DELETE /api/listings/:id — delete a listing
app.delete('/api/listings/:id', (req, res) => {
  let listings = readListings();
  const id = Number(req.params.id);
  const listing = listings.find(l => l.id === id);

  if (!listing) {
    return res.status(404).json({ success: false, message: 'Listing not found' });
  }

  listings = listings.filter(l => l.id !== id);
  writeListings(listings);

  res.json({ success: true, message: `Listing "${listing.title}" deleted successfully` });
});

// GET /api/stats — get summary stats
app.get('/api/stats', (req, res) => {
  const listings = readListings();
  const stats = {
    total: listings.length,
    rent: listings.filter(l => l.type === 'rent').length,
    sale: listings.filter(l => l.type === 'sale').length,
    land: listings.filter(l => l.type === 'land').length,
    featured: listings.filter(l => l.featured).length,
    cities: [...new Set(listings.map(l => l.city))],
    areas: [...new Set(listings.map(l => l.area))],
    priceRange: {
      min: Math.min(...listings.map(l => l.price)),
      max: Math.max(...listings.map(l => l.price))
    }
  };
  res.json({ success: true, data: stats });
});

// ── API Routes: Districts ──────────────────────────────────

// GET /api/districts — get all districts
app.get('/api/districts', (req, res) => {
  const districts = readDistricts();
  res.json({ success: true, count: districts.length, data: districts });
});

// POST /api/districts — create a new district
app.post('/api/districts', (req, res) => {
  const districts = readDistricts();
  const { name, city, description, checks, image, linkType } = req.body;

  if (!name || !city) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: name, city'
    });
  }

  const newDistrict = {
    id: getNextDistrictId(districts),
    name,
    city,
    description: description || '',
    checks: Array.isArray(checks) ? checks : [],
    image: image || '',
    linkType: linkType || 'all'
  };

  districts.push(newDistrict);
  writeDistricts(districts);

  res.status(201).json({ success: true, data: newDistrict });
});

// PUT /api/districts/:id — update a district
app.put('/api/districts/:id', (req, res) => {
  const districts = readDistricts();
  const index = districts.findIndex(d => d.id === Number(req.params.id));

  if (index === -1) {
    return res.status(404).json({ success: false, message: 'District not found' });
  }

  const updated = {
    ...districts[index],
    ...req.body,
    id: districts[index].id // never change the id
  };

  districts[index] = updated;
  writeDistricts(districts);

  res.json({ success: true, data: updated });
});

// DELETE /api/districts/:id — delete a district
app.delete('/api/districts/:id', (req, res) => {
  let districts = readDistricts();
  const id = Number(req.params.id);
  const district = districts.find(d => d.id === id);

  if (!district) {
    return res.status(404).json({ success: false, message: 'District not found' });
  }

  districts = districts.filter(d => d.id !== id);
  writeDistricts(districts);

  res.json({ success: true, message: `District "${district.name}" deleted successfully` });
});

// ── Start Server ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏠  PrimeProp Nigeria API running at http://localhost:${PORT}`);
  console.log(`📋  API endpoints:    http://localhost:${PORT}/api/listings`);
  console.log(`🗺️   Districts:        http://localhost:${PORT}/api/districts`);
  console.log(`🖥️   Admin panel:     http://localhost:${PORT}/admin.html`);
  console.log(`🌐  Website:          http://localhost:${PORT}/index.html\n`);
});
