# PrimeProp Nigeria — API & Deployment Guide

## 🔐 Access & Credentials

### Admin Account
| Field | Value |
|-------|-------|
| **Email** | `admin@primeprop.ng` |
| **Password** | `admin123` |
| **Role** | `admin` |
| **Capabilities** | Full CRUD on listings & districts, manage users (ban/delete/role-change) |

### Agent Account (example)
| Field | Value |
|-------|-------|
| **Email** | `agent@primeprop.ng` |
| **Password** | `Agent123A!` |
| **Role** | `agent` |
| **Capabilities** | Create listings, edit own listings, upload files. Cannot delete or manage users. |

### Cloudflare Account
| Field | Value |
|-------|-------|
| **Account** | `ndupsn@gmail.com` |
| **Account ID** | `84d56c30b002c3f304ceb55e5abc33cc` |
| **D1 Database** | `primeprop-db` (ID: `162aa04a-f169-43ea-a336-4365350dda4a`) |
| **R2 Bucket** | `primeprop-images` |
| **Worker URL** | `https://primeprop-worker.ndupsn.workers.dev` |

---

## 🔑 Google OAuth Setup

### 1. Create Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Go to **APIs & Services → Credentials**
4. Click **Create Credentials → OAuth 2.0 Client ID**
5. Set Application Type to **Web Application**

### 2. Configure Redirect URI
Add this exact URL as an authorized redirect URI:
```
https://primeprop-worker.ndupsn.workers.dev/auth/google/callback
```

### 3. Set Secrets in Cloudflare
```bash
cd /Users/knowtheledge/Desktop/html_folder/worker

# Set your Google OAuth credentials
wrangler secret put GOOGLE_CLIENT_ID
# Paste: your-client-id.apps.googleusercontent.com

wrangler secret put GOOGLE_CLIENT_SECRET
# Paste: your-client-secret

wrangler secret put GOOGLE_REDIRECT_URI
# Paste: https://primeprop-worker.ndupsn.workers.dev/auth/google/callback
```

### 4. Test OAuth Login
Visit: `https://primeprop-worker.ndupsn.workers.dev/auth/google`

---

## 📡 API Reference (OpenAI Function Calling Compatible)

### Base URL
```
https://primeprop-worker.ndupsn.workers.dev
```

### Authentication
All write endpoints require a JWT token in the `Authorization` header:
```
Authorization: Bearer <token>
```

Get a token by logging in (see Auth section below).

CSRF-protected endpoints also require:
```
X-CSRF-Token: <csrf_token>
```
(The CSRF token is returned in the login response.)

---

### 📋 Listings

#### `GET /api/listings` — List all listings
```json
{
  "name": "list_listings",
  "description": "Get all property listings with optional filters, pagination, and search",
  "parameters": {
    "type": "object",
    "properties": {
      "type": { "type": "string", "enum": ["rent", "sale", "land", "all"], "description": "Filter by listing type" },
      "city": { "type": "string", "description": "Filter by city (Lagos, Abuja)" },
      "area": { "type": "string", "description": "Filter by area/neighborhood" },
      "minPrice": { "type": "number", "description": "Minimum price in Naira" },
      "maxPrice": { "type": "number", "description": "Maximum price in Naira" },
      "bedrooms": { "type": "number", "description": "Minimum bedrooms" },
      "search": { "type": "string", "description": "Keyword search across title, location, description" },
      "featured": { "type": "string", "enum": ["true"], "description": "Only featured listings" },
      "verified": { "type": "string", "enum": ["true"], "description": "Only verified listings" },
      "sort": { "type": "string", "enum": ["price-asc", "price-desc", "newest", "featured"], "description": "Sort order" },
      "page": { "type": "number", "description": "Page number for pagination" },
      "limit": { "type": "number", "description": "Items per page (default 9, max 100)" }
    }
  }
}
```

**Example:**
```bash
# Get all listings
curl https://primeprop-worker.ndupsn.workers.dev/api/listings

# Get rent listings in Lagos, sorted by price
curl "https://primeprop-worker.ndupsn.workers.dev/api/listings?type=rent&city=Lagos&sort=price-asc"

# Search
curl "https://primeprop-worker.ndupsn.workers.dev/api/listings?search=Lekki&minPrice=5000000"

# Paginated
curl "https://primeprop-worker.ndupsn.workers.dev/api/listings?page=1&limit=9"
```

**Response:**
```json
{
  "success": true,
  "count": 12,
  "data": [
    {
      "id": 1,
      "title": "3-Bedroom Modern Apartment",
      "type": "rent",
      "property_type": "apartment",
      "price": 3500000,
      "priceDisplay": "₦3,500,000",
      "price_unit": "/ year",
      "location": "Lekki Phase 1, Lagos",
      "area": "Lekki Phase 1",
      "city": "Lagos",
      "bedrooms": 3,
      "bathrooms": 2,
      "sqft": 1200,
      "parking": 1,
      "description": "...",
      "amenities": ["24/7 Electricity", "Borehole Water Supply", "..."],
      "images": [
        { "url": "https://images.unsplash.com/...", "type": "image" }
      ],
      "availability": "Immediately",
      "featured": true,
      "verified": true,
      "badge": "Featured",
      "agent": {
        "name": "Ade Okafor",
        "role": "Listing Agent — Lagos",
        "phone": "2348000000001",
        "avatar": "https://randomuser.me/api/portraits/men/32.jpg",
        "initials": "AO"
      },
      "moveInCosts": {
        "annualRent": 3500000,
        "agencyFee": 350000,
        "securityDeposit": 291667,
        "serviceCharge": 200000,
        "total": 4341667
      }
    }
  ]
}
```

---

#### `GET /api/listings/:id` — Get single listing
```json
{
  "name": "get_listing",
  "description": "Get a single property listing by ID",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Listing ID" }
    },
    "required": ["id"]
  }
}
```

**Example:**
```bash
curl https://primeprop-worker.ndupsn.workers.dev/api/listings/1
```

---

#### `POST /api/listings` — Create listing (auth required)
```json
{
  "name": "create_listing",
  "description": "Create a new property listing. Requires authentication (admin or agent).",
  "parameters": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "description": "Property title (required, max 200 chars)" },
      "type": { "type": "string", "enum": ["rent", "sale", "land"], "description": "Listing type (required)" },
      "price": { "type": "number", "description": "Price in Naira (required)" },
      "location": { "type": "string", "description": "Full location string (required, max 300 chars)" },
      "property_type": { "type": "string", "enum": ["apartment", "duplex", "detached", "terrace", "villa", "land", "commercial", "semi-detached"], "description": "Property category" },
      "price_unit": { "type": "string", "description": "Price unit e.g. '/ year', '' for sale" },
      "area": { "type": "string", "description": "Area/neighborhood" },
      "city": { "type": "string", "description": "City (Lagos, Abuja)" },
      "bedrooms": { "type": "number", "description": "Number of bedrooms" },
      "bathrooms": { "type": "number", "description": "Number of bathrooms" },
      "sqft": { "type": "number", "description": "Square footage/SQM" },
      "parking": { "type": "number", "description": "Parking spaces" },
      "description": { "type": "string", "description": "Full description (max 5000 chars)" },
      "amenities": { "type": "array", "items": { "type": "string" }, "description": "List of amenities (max 20)" },
      "images": { "type": "array", "items": { "type": "string" }, "description": "Array of image URLs (max 20)" },
      "availability": { "type": "string", "description": "Availability status" },
      "featured": { "type": "boolean", "description": "Feature this listing" },
      "verified": { "type": "boolean", "description": "Mark as verified" },
      "badge": { "type": "string", "enum": ["Featured", "New", "Hot Deal", ""], "description": "Card badge" },
      "agent_name": { "type": "string", "description": "Agent display name" },
      "agent_role": { "type": "string", "description": "Agent role title" },
      "agent_phone": { "type": "string", "description": "WhatsApp phone number with country code" },
      "agent_avatar": { "type": "string", "description": "URL to agent profile picture" },
      "annual_rent": { "type": "number", "description": "Annual rent amount (rent type only)" },
      "agency_fee": { "type": "number", "description": "Agency fee amount" },
      "security_deposit": { "type": "number", "description": "Security deposit amount" },
      "service_charge": { "type": "number", "description": "Service charge amount" }
    },
    "required": ["title", "type", "price", "location"]
  }
}
```

**Example:**
```bash
# Login first to get token
TOKEN=$(curl -s -X POST https://primeprop-worker.ndupsn.workers.dev/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@primeprop.ng","password":"admin123"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")

# Create listing
curl -X POST https://primeprop-worker.ndupsn.workers.dev/api/listings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "New Luxury Apartment",
    "type": "rent",
    "price": 5000000,
    "location": "Ikoyi, Lagos",
    "property_type": "apartment",
    "city": "Lagos",
    "bedrooms": 3,
    "bathrooms": 2,
    "sqft": 1500,
    "description": "Beautiful new apartment in Ikoyi...",
    "amenities": ["Swimming Pool", "Gym", "24/7 Power", "Parking"],
    "images": ["https://images.unsplash.com/photo-xxx"],
    "agent_name": "Ade Okafor",
    "agent_phone": "2348000000001",
    "annual_rent": 5000000,
    "agency_fee": 500000,
    "security_deposit": 416667,
    "service_charge": 250000
  }'
```

---

#### `PUT /api/listings/:id` — Update listing (auth required)
```json
{
  "name": "update_listing",
  "description": "Update an existing listing. Admins can edit any listing; agents can only edit their own.",
  "parameters": {
    "type": "object",
    "properties": {
      "id": { "type": "number", "description": "Listing ID to update" },
      "title": { "type": "string" },
      "price": { "type": "number" },
      "...": { "description": "Same fields as create_listing. Only provided fields are updated." }
    },
    "required": ["id"]
  }
}
```

**Example:**
```bash
curl -X PUT https://primeprop-worker.ndupsn.workers.dev/api/listings/13 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title": "Updated Title", "price": 5500000, "featured": true}'
```

---

#### `DELETE /api/listings/:id` — Delete listing (admin only)
```bash
curl -X DELETE https://primeprop-worker.ndupsn.workers.dev/api/listings/13 \
  -H "Authorization: Bearer $TOKEN"
```

---

### 📊 Statistics

#### `GET /api/stats` — Get platform statistics
```bash
curl https://primeprop-worker.ndupsn.workers.dev/api/stats
```
**Response:**
```json
{
  "success": true,
  "data": {
    "total": 12,
    "rent": 5,
    "sale": 4,
    "land": 3,
    "featured": 3
  }
}
```

---

### 🗺️ Districts

#### `GET /api/districts` — List all districts
```bash
curl https://primeprop-worker.ndupsn.workers.dev/api/districts
```

#### `POST /api/districts` — Create district (admin only)
```bash
curl -X POST https://primeprop-worker.ndupsn.workers.dev/api/districts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "New District",
    "city": "Lagos",
    "description": "A new area guide...",
    "checks": ["Check 1", "Check 2"],
    "image": "https://images.unsplash.com/photo-xxx",
    "link_type": "all"
  }'
```

#### `PUT /api/districts/:id` — Update district (admin only)
#### `DELETE /api/districts/:id` — Delete district (admin only)

---

### 🔐 Authentication

#### `POST /auth/login` — Email/password login
```json
{
  "name": "login",
  "description": "Authenticate with email and password to receive a JWT token",
  "parameters": {
    "type": "object",
    "properties": {
      "email": { "type": "string", "description": "Registered email" },
      "password": { "type": "string", "description": "Account password" }
    },
    "required": ["email", "password"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiJ9...",
    "csrf": "a1b2c3d4...",
    "user": { "id": 1, "email": "admin@primeprop.ng", "name": "Admin", "role": "admin" }
  }
}
```

---

#### `POST /auth/register` — Create new user (admin only)
```json
{
  "name": "register_user",
  "description": "Create a new agent or admin account. Requires admin authentication.",
  "parameters": {
    "type": "object",
    "properties": {
      "email": { "type": "string", "description": "New user email" },
      "password": { "type": "string", "description": "Password (8+ chars, upper+lower+number)" },
      "name": { "type": "string", "description": "Display name" },
      "role": { "type": "string", "enum": ["admin", "agent"], "description": "User role" }
    },
    "required": ["email", "password", "name"]
  }
}
```

**Example:**
```bash
curl -X POST https://primeprop-worker.ndupsn.workers.dev/auth/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"email":"newagent@primeprop.ng","password":"SecurePass1!","name":"New Agent","role":"agent"}'
```

---

#### `GET /auth/session` — Verify token & refresh
```bash
curl https://primeprop-worker.ndupsn.workers.dev/auth/session \
  -H "Authorization: Bearer $TOKEN"
```
Returns refreshed token and user info.

---

#### `GET /auth/users` — List all users (admin only)
```bash
curl https://primeprop-worker.ndupsn.workers.dev/auth/users \
  -H "Authorization: Bearer $TOKEN"
```

#### `PUT /auth/users/:id` — Update user (admin only)
Ban/unban, change role, update name/phone:
```bash
# Ban a user
curl -X PUT https://primeprop-worker.ndupsn.workers.dev/auth/users/2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"account_status": "banned"}'

# Unban
curl -X PUT https://primeprop-worker.ndupsn.workers.dev/auth/users/2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"account_status": "active"}'

# Change role
curl -X PUT https://primeprop-worker.ndupsn.workers.dev/auth/users/2 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"role": "admin"}'
```

#### `DELETE /auth/users/:id` — Delete user (admin only)
```bash
curl -X DELETE https://primeprop-worker.ndupsn.workers.dev/auth/users/3 \
  -H "Authorization: Bearer $TOKEN"
```

#### `GET /auth/my-listings` — Get agent's own listings
```bash
curl https://primeprop-worker.ndupsn.workers.dev/auth/my-listings \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

#### `PUT /auth/profile` — Update own profile (self-service)
```bash
curl -X PUT https://primeprop-worker.ndupsn.workers.dev/auth/profile \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "New Name", "phone": "2348000000000"}'
```

---

### 📁 File Upload

#### `POST /api/images/upload` — Upload file (auth required)
```json
{
  "name": "upload_file",
  "description": "Upload an image, PDF, or video to R2 storage. Returns the URL to use in listing images array.",
  "parameters": {
    "type": "object",
    "properties": {
      "file": { "type": "string", "format": "binary", "description": "File to upload" }
    },
    "required": ["file"]
  }
}
```

**Supported formats:**
| Type | MIME Types | Max Size |
|------|-----------|----------|
| Images | JPEG, PNG, WebP, GIF, AVIF | 10 MB |
| PDFs | application/pdf | 10 MB |
| Videos | MP4, WebM, MOV | 50 MB |

**Example (curl):**
```bash
curl -X POST https://primeprop-worker.ndupsn.workers.dev/api/images/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/image.jpg"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "key": "listings/images/1234567890-image.jpg",
    "url": "/api/images/listings/images/1234567890-image.jpg",
    "type": "image/jpeg",
    "size": 245000
  }
}
```

Use the returned `url` in the `images` array when creating/updating a listing.

---

### 🤖 OpenAI Function Calling — Full Schema

For AI agents to interact with the API, here's the complete function definitions:

```json
{
  "functions": [
    {
      "name": "search_listings",
      "description": "Search property listings with filters",
      "parameters": {
        "type": "object",
        "properties": {
          "type": { "type": "string", "enum": ["rent", "sale", "land", "all"] },
          "city": { "type": "string" },
          "minPrice": { "type": "number" },
          "maxPrice": { "type": "number" },
          "bedrooms": { "type": "number" },
          "search": { "type": "string" },
          "sort": { "type": "string", "enum": ["price-asc", "price-desc", "newest", "featured"] }
        }
      }
    },
    {
      "name": "get_listing_details",
      "description": "Get full details of a specific listing",
      "parameters": {
        "type": "object",
        "properties": {
          "id": { "type": "number", "description": "Listing ID" }
        },
        "required": ["id"]
      }
    },
    {
      "name": "create_listing",
      "description": "Create a new property listing",
      "parameters": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "type": { "type": "string", "enum": ["rent", "sale", "land"] },
          "price": { "type": "number" },
          "location": { "type": "string" },
          "city": { "type": "string" },
          "bedrooms": { "type": "number" },
          "bathrooms": { "type": "number" },
          "description": { "type": "string" },
          "amenities": { "type": "array", "items": { "type": "string" } },
          "images": { "type": "array", "items": { "type": "string" } },
          "agent_name": { "type": "string" },
          "agent_phone": { "type": "string" }
        },
        "required": ["title", "type", "price", "location"]
      }
    },
    {
      "name": "get_platform_stats",
      "description": "Get total listing counts by type",
      "parameters": { "type": "object", "properties": {} }
    }
  ]
}
```

---

## 🚀 Deployment Commands

```bash
cd /Users/knowtheledge/Desktop/html_folder/worker

# Deploy worker + assets
wrangler deploy

# Apply database migrations
wrangler d1 migrations apply primeprop-db --remote

# Set secrets
wrangler secret put JWT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REDIRECT_URI

# View logs
wrangler tail

# Local development
wrangler dev
```

---

## 🔒 Security Summary
- **Rate Limiting:** 30/min login, 10/min register, 120/min writes
- **Password Policy:** 8+ chars, upper+lower+number, bcrypt 12 rounds
- **JWT:** 8h expiry, issuer-validated, role refreshed from DB
- **CSRF:** Double-submit cookie pattern
- **CORS:** Whitelist-based
- **CSP:** Strict content security policy
- **HSTS:** Preload-ready, 2-year max-age
- **File Upload:** MIME whitelist + size limits
- **Input Validation:** All inputs sanitized

## 📦 Project Structure
```
html_folder/
├── worker/              # Cloudflare Worker (Hono.js)
│   ├── src/
│   │   ├── index.ts     # Main API + static serving
│   │   └── auth.ts      # Auth, JWT, user management
│   ├── migrations/      # D1 SQL migrations
│   └── wrangler.toml    # Cloudflare config
├── js/app.js            # Frontend rendering, search, cache
├── styles.css           # Shared styles + skeleton + lightbox
├── admin.html           # Admin panel (listings + districts + users)
├── index.html           # Homepage
├── properties*.html     # Listing pages (dynamic)
├── listing-detail.html  # Dynamic detail page
└── areas.html           # Area guides (dynamic)
```
