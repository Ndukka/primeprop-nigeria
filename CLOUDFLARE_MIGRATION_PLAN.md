# PrimeProp Nigeria — Cloudflare Migration Plan

## ⚠️ Prerequisite: Authentication Required

Wrangler CLI is installed (v4.34.0) but **not authenticated**. You need to run:

```bash
wrangler login
```

Or set `CLOUDFLARE_API_TOKEN` in your environment. This is required before any deployment.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                  Cloudflare Worker                     │
│  (Hono.js — lightweight router for Workers)           │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │  Static  │  │   REST   │  │   Auth Routes    │   │
│  │  Assets  │  │   API    │  │  /auth/login     │   │
│  │  /       │  │  /api/*  │  │  /auth/register  │   │
│  │  HTML/   │  │          │  │  /auth/session   │   │
│  │  CSS/JS  │  │          │  │                  │   │
│  └──────────┘  └──────────┘  └──────────────────┘   │
│                      │                               │
│            ┌─────────┴─────────┐                     │
│            │   Auth Middleware  │                     │
│            │  (JWT validation) │                     │
│            │  Role: admin |    │                     │
│            │  lister           │                     │
│            └─────────┴─────────┘                     │
└──────────────────────────────────────────────────────┘
         │                    │
    ┌────▼────┐          ┌───▼────┐
    │   D1    │          │   R2   │
    │ (SQLite)│          │(Images)│
    │         │          │        │
    │• users  │          │ Bucket:│
    │• listings│         │ prime- │
    │• districts│        │ prop-  │
    │• sessions│         │ images │
    └─────────┘          └────────┘
```

## Database Schema (D1)

### Table: `users`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | |
| email | TEXT UNIQUE NOT NULL | Login identifier |
| password_hash | TEXT NOT NULL | bcrypt hash |
| name | TEXT NOT NULL | Display name |
| role | TEXT NOT NULL DEFAULT 'lister' | 'admin' or 'lister' |
| avatar_url | TEXT | Profile picture |
| phone | TEXT | WhatsApp number |
| created_at | TEXT DEFAULT (datetime('now')) | |
| updated_at | TEXT DEFAULT (datetime('now')) | |

### Table: `listings`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | |
| title | TEXT NOT NULL | |
| type | TEXT NOT NULL | 'rent', 'sale', 'land' |
| property_type | TEXT | 'apartment', 'duplex', etc. |
| price | INTEGER NOT NULL | In Naira |
| price_unit | TEXT | '/ year', '' |
| location | TEXT NOT NULL | |
| area | TEXT | |
| city | TEXT | |
| bedrooms | INTEGER DEFAULT 0 | |
| bathrooms | INTEGER DEFAULT 0 | |
| sqft | INTEGER DEFAULT 0 | |
| parking | INTEGER DEFAULT 0 | |
| description | TEXT | |
| amenities | TEXT | JSON array stored as text |
| images | TEXT | JSON array of R2 URLs |
| availability | TEXT DEFAULT 'Immediately' | |
| featured | INTEGER DEFAULT 0 | Boolean (0/1) |
| verified | INTEGER DEFAULT 0 | Boolean (0/1) |
| badge | TEXT | 'Featured', 'New', 'Hot Deal' |
| agent_name | TEXT | |
| agent_role | TEXT | |
| agent_phone | TEXT | |
| agent_avatar | TEXT | |
| annual_rent | INTEGER | Move-in cost |
| agency_fee | INTEGER | Move-in cost |
| security_deposit | INTEGER | Move-in cost |
| service_charge | INTEGER | Move-in cost |
| created_by | INTEGER | FK → users.id |
| created_at | TEXT DEFAULT (datetime('now')) | |
| updated_at | TEXT DEFAULT (datetime('now')) | |

### Table: `districts`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT | |
| name | TEXT NOT NULL | |
| city | TEXT NOT NULL | |
| description | TEXT | |
| checks | TEXT | JSON array |
| image | TEXT | R2 URL |
| link_type | TEXT DEFAULT 'all' | 'all', 'sale', 'rent', 'land' |
| created_at | TEXT DEFAULT (datetime('now')) | |

## API Endpoints

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /auth/login | None | Login, returns JWT |
| POST | /auth/register | Admin | Create user account |
| GET | /auth/session | JWT | Get current session |
| POST | /auth/logout | JWT | Invalidate session |

### Listings (mirrors current API)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/listings | None | List with filters, pagination |
| GET | /api/listings/:id | None | Single listing |
| POST | /api/listings | Admin/Lister | Create listing |
| PUT | /api/listings/:id | Admin/Lister | Update own listing |
| DELETE | /api/listings/:id | Admin | Delete listing |
| GET | /api/stats | None | Statistics |

### Districts
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/districts | None | List all |
| POST | /api/districts | Admin | Create |
| PUT | /api/districts/:id | Admin | Update |
| DELETE | /api/districts/:id | Admin | Delete |

### Images (R2)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/images/upload | Admin/Lister | Upload to R2 |
| GET | /api/images/:key | None | Serve from R2 |

## Auth Flow

1. **Admin creates lister accounts** via admin panel
2. **Login**: POST `/auth/login` with email + password → returns JWT token
3. **JWT stored** in localStorage (admin panel) or cookie
4. **Middleware** validates JWT on protected routes
5. **Roles**: `admin` (full access) vs `lister` (can only edit own listings)

## Role Permissions

| Action | Admin | Lister | Public |
|--------|-------|--------|--------|
| View listings | ✅ | ✅ | ✅ |
| Create listing | ✅ | ✅ | ❌ |
| Edit any listing | ✅ | ❌ | ❌ |
| Edit own listing | ✅ | ✅ | ❌ |
| Delete listing | ✅ | ❌ | ❌ |
| Manage districts | ✅ | ❌ | ❌ |
| Manage users | ✅ | ❌ | ❌ |
| Upload images | ✅ | ✅ | ❌ |
| View admin panel | ✅ | ✅ | ❌ |

## Migration Steps

### Step 1: Create Cloudflare Resources
```bash
# Create D1 database
wrangler d1 create primeprop-db

# Create R2 bucket
wrangler r2 bucket create primeprop-images

# Create Worker
wrangler init primeprop-worker
```

### Step 2: Build Worker (Hono.js)
- Install Hono for routing
- Implement auth (JWT + bcrypt via Web Crypto)
- Implement all API endpoints
- Serve static frontend files
- Middleware for role-based access

### Step 3: Database Migration
- Create D1 migration SQL for all tables
- Seed initial data (admin user + sample listings)
- Apply migration

### Step 4: Update Frontend
- Update `js/app.js` API_BASE to point to production URL
- Add login page for admin panel
- Add auth token to admin API calls

### Step 5: Deploy
```bash
wrangler deploy
```

## Limitations & Risks

1. **Wrangler not authenticated** — Must run `wrangler login` first
2. **Bcrypt in Workers** — Need `bcryptjs` (pure JS, compatible with Workers)
3. **Static assets in Workers** — Worker has 1MB script size limit; large assets should go to R2 or Pages
4. **D1 is SQLite** — No Postgres features; JSON stored as text
5. **R2 for images** — Need to update existing Unsplash URLs to R2 URLs, or keep Unsplash for external images
6. **CORS** — Worker needs CORS headers for API access from different domains
7. **Cold starts** — Workers have minimal cold start; D1 queries add latency

## What I Need From You

Before I can implement:

1. **Run `wrangler login`** to authenticate the CLI (opens browser)
2. **Confirm:** Keep using Unsplash URLs for listing images, or upload to R2?
3. **Confirm:** Admin email/password you want for the initial admin account
4. **Confirm:** Do you want the admin panel to have a login page, or use Cloudflare Access (simpler, no code)?
