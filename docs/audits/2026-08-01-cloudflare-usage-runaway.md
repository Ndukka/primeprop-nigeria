# Cloudflare usage runaway audit — 2026-08-01

## Finding

The deployed Worker does not configure a Cloudflare Queue producer or consumer. The dashboard line showing `0% of daily Queues used` is therefore expected and is not the exhausted quota.

The actual runaway is the Durable Object rate limiter. Each unique `limitKey + IP address` is mapped to a distinct Durable Object. The current constructor schedules an alarm every 60 seconds, and the alarm handler unconditionally schedules the next alarm even after all expired entries have been deleted. This converts every visitor or bot IP into a permanent once-per-minute Durable Object invocation.

On the Workers Free plan, Durable Object requests—including alarm invocations—are limited to 100,000 per day. A permanently recurring alarm consumes 1,440 requests per object per day. Seventy objects consume approximately 100,800 alarm requests per day before ordinary rate-limit RPC calls are counted.

A second amplification exists in static asset routing: `assets.run_worker_first = true` sends HTML, CSS, JavaScript, and every other static asset request through the Worker. Static asset requests are free only when they bypass the Worker script. The generated application already emits content-hashed assets under `/assets/`, so those immutable files can safely bypass the Worker while HTML and dynamic routes continue through it.

## Required repair

1. Replace recurring rate-limit cleanup alarms with one-shot expiry alarms.
2. Do not schedule an alarm in the Durable Object constructor.
3. Schedule one alarm only when a fresh rate-limit window is created.
4. Delete the rate-limit entry when the alarm fires and do not reschedule it.
5. Delete the pending alarm when a rate limit is explicitly reset.
6. Route generated `/assets/*` files directly to Static Assets rather than invoking the Worker.
7. Add regression tests that reject recurring alarm scheduling and unrestricted `run_worker_first = true`.

## Production behavior after deployment

Existing recurring alarms will invoke the updated `alarm()` handler once, delete their expired state, and stop because the updated handler does not schedule another alarm. The runaway should therefore quench shortly after the repaired Worker is deployed.
