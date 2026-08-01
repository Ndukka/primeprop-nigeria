# Role profile and listing-boundary audit

## Confirmed defects

1. The administrator statistics endpoint and table used different client paths. Statistics could show live D1 counts while the table rendered an empty or cached public catalogue response.
2. Agent contact and identity fields were repeated inside every listing form instead of belonging to the user profile.
3. The agent page exposed Badge and Featured controls even though the API ignored them for agents.
4. The property-type allowlist and selectors did not contain Service Apartment.
5. Role restrictions existed at the API layer but lacked a database-level invariant protecting agent-owned listing identity and trust fields from direct or future buggy writes.

## Implemented boundary

- Administrators load listing management data from authenticated `/auth/admin-listings` with `Cache-Control: no-store`.
- Public catalogue reads remain on `/api/listings` and retain public DTO/privacy behavior.
- Agents edit name, WhatsApp phone, listing title/role, and profile picture once through `/auth/profile-settings`.
- Existing and future agent-owned listings inherit the saved account profile.
- Browser listing writes use `/auth/listing-records` and `/auth/listing-records/:id`.
- Agents may edit factual property data only.
- Badge, Featured, Verified, and listing identity overrides remain administrator-only.
- D1 triggers normalize new agent listings, propagate profile edits, and reject noncanonical agent trust/identity values.
- `service-apartment` is the canonical stored property type and is labelled “Service Apartment” in admin, agent, and public selectors.

## Compatibility and privacy

- Existing public listing endpoints remain available.
- Public listing DTOs continue to hide private agent phone numbers.
- Existing seeded listings and districts are not replaced.
- Migration `0014_agent_profiles_and_listing_guards.sql` is forward-only.
