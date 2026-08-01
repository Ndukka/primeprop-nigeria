import './role-profile-routes';
import { DurableObject } from 'cloudflare:workers';

// ── Rate Limiter Durable Object ───────────────────────────
// Solves the problem of in-memory rate limiting being stateless
// (each Worker request gets a fresh isolate, so Map resets every time).
// This DO provides shared, persistent rate-limit state across all requests.

const WINDOW_MS = 60_000; // 1 minute window
const CLEANUP_INTERVAL_MS = 60_000; // alarm-based cleanup every 60 seconds
const MAX_AGE_MS = 5 * 60_000; // force-delete entries older than 5 minutes
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

    // One-time cleanup of expired entries on construction
    ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const expired = new Set<string>();
      const entries = await this.storage.list<RateEntry>();
      for (const [key, entry] of entries) {
        if (now > entry.resetAt) expired.add(key);
      }
      if (expired.size > 0) {
        await this.storage.delete(Array.from(expired));
      }
    });

    // Schedule recurring alarm-based cleanup (PP-SEC-040)
    ctx.blockConcurrencyWhile(async () => {
      const existingAlarm = await ctx.storage.getAlarm();
      if (!existingAlarm) {
        await ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
      }
    });
  }

  // Check if a request should be rate limited
  // Returns { allowed: true } or { allowed: false, retryAfter: seconds }
  async checkLimit(key: string, limit: number = DEFAULT_LIMIT): Promise<{ allowed: boolean; retryAfter?: number }> {
    const now = Date.now();
    let entry = await this.storage.get<RateEntry>(key);

    if (!entry || now > entry.resetAt) {
      // New window
      entry = { count: 1, resetAt: now + WINDOW_MS };
      await this.storage.put(key, entry);
      return { allowed: true };
    }

    if (entry.count >= limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.count++;
    await this.storage.put(key, entry);
    return { allowed: true };
  }

  // Reset a specific key (e.g., after successful auth)
  async resetLimit(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  // PP-SEC-040: Alarm-based recurring cleanup
  // Durable Object alarms provide reliable periodic cleanup even if the DO
  // is evicted and recreated. Deletes expired entries and force-removes
  // entries older than MAX_AGE_MS to bound storage growth.
  async alarm(): Promise<void> {
    const now = Date.now();
    const expired = new Set<string>();
    const entries = await this.storage.list<RateEntry>();

    for (const [key, entry] of entries) {
      // Delete if window has expired
      if (now > entry.resetAt) {
        expired.add(key);
      }
      // Force-delete stale entries beyond max age to bound storage
      // (entry.resetAt is set to now + WINDOW_MS at creation, so a
      // stuck entry would have a resetAt far in the past)
      if (now - entry.resetAt > MAX_AGE_MS) {
        expired.add(key);
      }
    }

    if (expired.size > 0) {
      await this.storage.delete(Array.from(expired));
    }

    // Schedule the next cleanup
    await this.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
  }
}
