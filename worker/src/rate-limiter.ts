import './role-profile-routes';
import './admin-inventory-routes';
import './listing-approval-routes';
import { DurableObject } from 'cloudflare:workers';

// ── Rate Limiter Durable Object ───────────────────────────
// Each limit key is mapped to its own Durable Object instance. A single
// one-shot alarm removes the current rate window after it expires. Never use a
// recurring alarm here: alarm invocations are billable Durable Object requests,
// and a permanent once-per-minute alarm per visitor IP can exhaust the daily
// account allowance even after traffic has stopped.

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 200;

interface RateEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter extends DurableObject<{}> {
  private storage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: {}) {
    super(ctx, env);
    this.storage = ctx.storage;
  }

  // Check if a request should be rate limited.
  // Returns { allowed: true } or { allowed: false, retryAfter: seconds }.
  async checkLimit(key: string, limit: number = DEFAULT_LIMIT): Promise<{ allowed: boolean; retryAfter?: number }> {
    const now = Date.now();
    let entry = await this.storage.get<RateEntry>(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 1, resetAt: now + WINDOW_MS };
      await this.storage.put(key, entry);

      // Replace any legacy recurring alarm with the expiry for this window.
      // The alarm fires once and is not rescheduled by alarm().
      await this.storage.setAlarm(entry.resetAt);
      return { allowed: true };
    }

    if (entry.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      return { allowed: false, retryAfter };
    }

    entry.count += 1;
    await this.storage.put(key, entry);
    return { allowed: true };
  }

  // Reset a specific key after a successful authentication event. Each object
  // owns one key, so its one-shot alarm can also be removed immediately.
  async resetLimit(key: string): Promise<void> {
    await this.storage.delete(key);
    await this.storage.deleteAlarm();
  }

  // One-shot expiry cleanup. Existing production objects that still have the
  // old recurring alarm will execute this updated handler once after deploy,
  // clear their state, and stop because no replacement alarm is scheduled.
  async alarm(): Promise<void> {
    const entries = await this.storage.list<RateEntry>();
    if (entries.size > 0) {
      await this.storage.delete(Array.from(entries.keys()));
    }
  }
}
