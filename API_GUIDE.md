# PrimeProp Nigeria — API Guide

**Base URL:** `https://primeprop-worker.ndupsn.workers.dev`  
**Auth method:** HttpOnly cookies (browser) or Bearer token (API clients)  

---

## Demo Credentials

| Role | Email | Password |
|---|---|---|
| Admin | `admin@primeprop.ng` | `Admin123!` |
| Agent | Create via signup, then admin approves | — |

---

## Authentication

### Login
```
POST /auth/login
Content-Type: application/json

{"email": "admin@primeprop.ng", "password": "Admin123!"}
```

Response:
```json
{
  "success": true,
  "data": {
    "token": "eyJ...",
    "csrf": "067b...",
    "user": {"id": 1, "email": "admin@primeprop.ng", "name": "Admin", "role": "admin"}
  }
}
```

- **Browser auth:** Cookies (`pp_session`, `pp_refresh`) are set automatically. Use `credentials: 'include'` in fetch calls.
- **API clients:** Use `Authorization: Bearer <token>` header.
- **CSRF:** Write operations require `X-CSRF-Token` header (read from `pp_csrf` cookie in browser).

### Session Check
```
GET /auth/session
# Browser: credentials: 'include'
# API: Authorization: Bearer <token>
```

### Logout
```
POST /auth/logout
# Requires CSRF token (browser)
```

### Signup (Public)
```
POST /auth/signup
{"email": "agent@example.com", "password": "AgentPass1", "name": "Agent Name"}
```
New accounts are `pending` — admin must approve before login.

### Register (Admin only)
```
POST /auth/register
Authorization: Bearer <admin-token>
{"email": "new-agent@example.com", "password": "AgentPass1", "name": "Agent Name", "role": "agent"}
```

---

## Listings API

### List listings (paginated)
```
GET /api/listings?page=1&limit=20&type=rent&city=Lagos&sort=newest
```

Query params:
| Param | Values | Default |
|---|---|---|
| `page` | 1–1000 | 1 |
| `limit` | 1–100 | 20 |
| `type` | `all`, `rent`, `sale`, `land` | `all` |
| `city` | e.g., `Lagos`, `Abuja` | — |
| `area` | partial match | — |
| `minPrice`, `maxPrice` | number | — |
| `bedrooms` | number | — |
| `search` | keyword search | — |
| `sort` | `price-asc`, `price-desc`, `newest`, `featured` | `featured` |

### Get single listing
```
GET /api/listings/:id
```

### Create listing (authenticated)
```
POST /api/listings
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "3-Bedroom Flat",
  "type": "rent",
  "price": 1500000,
  "location": "Lekki, Lagos",
  "description": "Spacious flat...",
  "bedrooms": 3,
  "bathrooms": 2,
  "sqft": 1200,
  "amenities": ["Parking", "Security"],
  "images": ["https://images.unsplash.com/photo-..."],
  "availability": "Immediately"
}
```

**Agent restrictions:** Agents cannot set `verified`, `featured`, `badge`, or impersonate other agents. Trust fields are admin-only.

### Update listing
```
PUT /api/listings/:id
Authorization: Bearer <token>
{"title": "Updated Title", "price": 1600000}
```

### Delete listing
```
DELETE /api/listings/:id
Authorization: Bearer <token>
```

---

## Stats
```
GET /api/stats
```
Returns: `{total, rent, sale, land, featured}`

---

## Districts (Admin only)

```
GET /api/districts
POST /api/districts
PUT /api/districts/:id
DELETE /api/districts/:id
```

---

## Cities (Admin write)

```
GET /api/cities
POST /api/cities
PUT /api/cities/:id
DELETE /api/cities/:id
```

---

## Image Upload

```
POST /api/images/upload
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: <image file>
# or
files: <multiple files>
```

Limits: 5 files/request, 50 uploads/user/day, 10MB images, 50MB videos/PDFs.  
Allowed types: JPEG, PNG, GIF, WebP, AVIF, PDF, MP4, WebM, MOV.

---

## Users (Admin only)

```
GET /auth/users                    # List all
GET /auth/users/:id                # Get single
PUT /auth/users/:id                # Update (role, status, name)
DELETE /auth/users/:id             # Delete (with safeguards)
```

Account statuses: `pending` → `active` / `banned`

---

## Uploads (Admin only)

```
GET /api/uploads?page=1&limit=20   # List with ownership
DELETE /api/uploads/:id            # Delete from R2 + DB
```

---

## Rate Limits

| Endpoint | Requests/min |
|---|---|
| Login | 10 |
| Signup | 3 |
| Register | 5 |
| Forgot password | 3 |
| Reset password | 3 |
| Upload | 10 |
| Other writes | 60 |
| Reads | 300 |

---

## Security

- **JWT tokens** with `token_use` claim (access vs refresh)
- **HttpOnly cookies** for browser sessions
- **CSRF protection** on all state-changing routes
- **Strict CSP** with per-request nonces
- **Password hashing:** bcrypt cost 12, auto-upgrade on login
- **Pending accounts:** new signups require admin approval
- **Role-based access:** agents cannot self-verify or impersonate
