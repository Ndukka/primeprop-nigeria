# Google feedback callback and production release runbook

This runbook covers the separate Google reviewer sign-in used for agent ratings, agent reports and listing reports.

## Two values that must not be confused

### `GOOGLE_FEEDBACK_REDIRECT_URI`

This is the **complete OAuth callback URL**, including the callback path.

Current Worker callback:

```text
https://primeprop-worker.ndupsn.workers.dev/auth/feedback/google/callback
```

Supported future main-domain callback:

```text
https://primeprop.ng/auth/feedback/google/callback
```

The value registered in Google Cloud and the value stored on the Worker must match exactly. Do not add a trailing slash, query string or fragment.

### `PRIMEPROP_BASE_URL`

This is the **origin only** used by deployment verification. It must not contain `/auth/feedback/google/callback` or any other path.

Current verification origin:

```text
https://primeprop-worker.ndupsn.workers.dev
```

Future main-domain verification origin, after the custom domain is active and serving the Worker:

```text
https://primeprop.ng
```

## Change the Google reviewer callback safely

1. Add the new complete callback URI to the OAuth web client under **Authorized redirect URIs** in Google Cloud.
2. Keep the old callback URI registered until the new domain has been verified end to end.
3. From the repository's `worker/` directory, run the tested Wrangler wrapper:

```bash
cd "/Users/knowtheledge/Desktop/html_folder/worker" || exit 1
node ./scripts/run-wrangler.mjs secret put GOOGLE_FEEDBACK_REDIRECT_URI
```

4. At the secure prompt, paste exactly one of these values:

```text
https://primeprop-worker.ndupsn.workers.dev/auth/feedback/google/callback
```

or, after the main domain is ready:

```text
https://primeprop.ng/auth/feedback/google/callback
```

5. Test Google reviewer sign-in, return-path handling, rating submission and listing reporting before removing the old URI from Google Cloud.

Cloudflare's `secret put` command creates and deploys a new Worker version immediately. Add the URI to Google before running the command, and follow the secret change with the verified production release command below.

## Commands not to use

Do not use:

```bash
npx wrangler secret put GOOGLE_FEEDBACK_REDIRECT_URI
npx wrangler deploy
wrangler deploy
```

Do not run Wrangler from the repository root. Do not place the secret value directly after the command because that can expose it through shell history. Use `node ./scripts/run-wrangler.mjs` from `worker/` so the repository-pinned Wrangler version is selected.

Do not use either of these as the callback value:

```text
https://primeprop.ng
https://primeprop.ng/
```

The callback must include:

```text
/auth/feedback/google/callback
```

## Fail-closed production release

After pulling the intended `main` commit and running `npm ci` from `worker/`, use:

```bash
cd "/Users/knowtheledge/Desktop/html_folder/worker" || exit 1

PRIMEPROP_BASE_URL="https://primeprop-worker.ndupsn.workers.dev" \
  npm run release:production:verified
```

When the main domain becomes the canonical Worker origin, use:

```bash
PRIMEPROP_BASE_URL="https://primeprop.ng" \
  npm run release:production:verified
```

`release:production:verified` performs these steps in order:

1. Lists pending remote D1 migrations.
2. Applies pending remote D1 migrations.
3. Lists migrations again and refuses to continue if any remain.
4. Builds and deploys the Worker.
5. Runs deployment verification.

Any migration failure stops the process before deployment. Do not manually continue to `deploy:verified` after a migration error.

Successful completion must include both:

```text
primeprop_production_release_passed
primeprop_deployment_verification_passed
```

and the deployment verifier must report:

```json
"failures": []
```

## D1 `incomplete input` recovery

Migration `0018_feedback_and_reviewer_identities.sql` contains rating-eligibility triggers. D1's remote parser can misinterpret an unparenthesized `CASE ... END` inside a trigger as the trigger terminator, returning:

```text
incomplete input: SQLITE_ERROR [code: 7500]
```

The repository migration keeps each trigger `CASE` expression parenthesized for remote D1 compatibility. If the error appears:

1. Stop. Do not deploy.
2. Pull the latest `main` commit.
3. Confirm `0018_feedback_and_reviewer_identities.sql` contains `SELECT (CASE` and not `SELECT CASE`.
4. Run `npm ci` from `worker/`.
5. Run `release:production:verified` again.

Cloudflare documents that a failed D1 migration is rolled back while earlier successful migrations remain applied. Confirm the remote migration list after every failure before taking another action.
