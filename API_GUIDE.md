# PrimeProp Nigeria API Guide

**Production base URL:** `https://primeprop-worker.ndupsn.workers.dev`  
**Browser authentication:** Secure, HttpOnly cookies  
**Non-browser API authentication:** Bearer access token

> Production credentials are never documented or committed. Administrator accounts must be created through the approved bootstrap procedure and their credentials stored in a password manager. The isolated test suite uses `.invalid` email addresses and test-only secrets.

## Authentication

### Login

```http
POST /auth/login
Content-Type: application/json

{
  "email": "administrator@example.com",
  "password": "<password>"
}
```

A successful browser login sets:

- `pp_session`: short-lived access cookie
- `pp_refresh`: rotating refresh cookie
- `pp_csrf`: CSRF token readable by same-origin JavaScript

Browser requests must use `credentials: "include"`. State-changing browser requests must also send the `pp_csrf` value in the `X-CSRF-Token` header.

Non-browser clients may use the access token returned by the login endpoint as an `Authorization: Bearer <token>` header. Refresh tokens must never be sent as bearer access tokens.

### Session check

```http
GET /auth/session
```

### Logout

```http
POST /auth/logout
X-CSRF-Token: <csrf-cookie-value>
```

Logout revokes the refresh-token family and clears the authentication cookies.

### Public signup

```http
POST /auth/signup
Content-Type: application/json

{
  "email": "agent@example.com",
  "password": "<password>",
  "name": "Agent Name"
}
```

Public signups are created with `pending` status and cannot sign in until an administrator approves them.

### Administrator-created account

```http
POST /auth/register
Authorization: Bearer <admin-access-token>
Content-Type: application/json

{
  "email": "new-agent@example.com",
  "password": "<temporary-password>",
  "name": "Agent Name",
  "role": "agent"
}
```

### Password recovery

```http
POST /auth/forgot-password
Content-Type: application/json

{
  "email": "user@example.com"
}
```

The endpoint always returns the same external response. Reset tokens must be delivered through the configured email provider. They must never be returned by the API, printed to logs, or placed in source control.

```http
POST /auth/reset-password
Content-Type: application/json

{
  "token": "<single-use-token>",
  "password": "<new-password>"
}
```

## Listings

### List listings

```http
GET /api/listings?page=1&limit=20&type=rent&city=Lagos&sort=newest
```

| Parameter | Accepted values | Default |
|---|---|---|
| `page` | 1 to 1000 | 1 |
| `limit` | 1 to 100 | 20 |
| `type` | `all`, `rent`, `sale`, `land` | `all` |
| `city` | Exact city name | None |
| `area` | Partial area match | None |
| `minPrice` | Nonnegative integer | None |
| `maxPrice` | Nonnegative integer | None |
| `bedrooms` | Nonnegative integer | None |
| `search` | Search text | None |
| `sort` | `price-asc`, `price-desc`, `newest`, `featured` | `featured` |

### Get one listing

```http
GET /api/listings/:id
```

### Create a listing

```http
POST /api/listings
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "title": "3-Bedroom Flat",
  "type": "rent",
  "price": 1500000,
  "location": "Lekki, Lagos",
  "description": "Spacious flat",
  "bedrooms": 3,
  "bathrooms": 2,
  "sqft": 1200,
  "amenities": ["Parking", "Security"],
  "images": ["/api/images/listings/images/<object-id>.jpg"],
  "availability": "Immediately"
}
```

Agents cannot set `verified`, `featured`, moderation status, trust badges, or another user's identity. Those fields are controlled by authorized staff.

### Update a listing

```http
PUT /api/listings/:id
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "title": "Updated title",
  "price": 1600000
}
```

### Delete a listing

```http
DELETE /api/listings/:id
Authorization: Bearer <access-token>
```

## Statistics

```http
GET /api/stats
```

Returns counts for all, rent, sale, land, and featured listings.

## Districts

Public read:

```http
GET /api/districts
```

Administrator writes:

```http
POST /api/districts
PUT /api/districts/:id
DELETE /api/districts/:id
```

## Cities

Public read:

```http
GET /api/cities
```

Administrator writes:

```http
POST /api/cities
PUT /api/cities/:id
DELETE /api/cities/:id
```

## Uploads

```http
POST /api/images/upload
Authorization: Bearer <access-token>
Content-Type: multipart/form-data
```

Use `file` for one file or `files` for multiple files.

Current application limits:

- 5 files per request
- 50 successful uploads per user per UTC day
- 10 MB per image
- 50 MB per PDF or video

The server validates the declared type, extension, and supported file signature before storing a file. Uploaded object ownership is recorded in D1.

Administrator upload inventory:

```http
GET /api/uploads?page=1&limit=20
DELETE /api/uploads/:id
```

## Users

Administrator-only routes:

```http
GET /auth/users
GET /auth/users/:id
PUT /auth/users/:id
DELETE /auth/users/:id
```

Account statuses are `pending`, `active`, and `banned`.

## Rate limits

| Route category | Requests per minute |
|---|---:|
| Login | 10 |
| Signup | 3 |
| Administrator registration | 5 |
| Forgot password | 3 |
| Reset password | 3 |
| Upload | 10 |
| Other writes | 60 |
| Reads | 300 |

Application rate limits supplement, rather than replace, Cloudflare edge controls.

## Security controls

- Access and refresh JWTs carry distinct `token_use` claims.
- Browser sessions use Secure, HttpOnly cookies.
- Cookie-authenticated writes require an Origin check and matching CSRF token.
- HTML responses use a per-request CSP nonce.
- Passwords use bcrypt with cost 12 and are upgraded after a successful login when needed.
- Public agent signups remain pending until approval.
- Listing ownership and role checks are enforced by the API.
- Production secrets belong in Cloudflare Secrets or Secrets Store, never `[vars]` or Git.

## Local verification

From `worker/`:

```bash
npm ci
npm run typecheck
npm run test:static
npm run test:worker
npm run test:integration
```

The integration suite creates an isolated local Wrangler state directory, applies D1 migrations, verifies HTML/CSP behavior, and checks that `/styles.css` and `/js/app.js` are served.
