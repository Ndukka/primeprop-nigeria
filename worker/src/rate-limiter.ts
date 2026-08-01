import { DurableObject } from 'cloudflare:workers';

// ── Rate Limiter Durable Object ───────────────────────────
// Solves the problem of in-memory rate limiting being stateless
// (each Worker request gets a fresh isolate, so Map resets every time).
// This DO provides shared, persistent rate-limit state across all requests.

const WINDOW_MS = 60_000; // 1 minute window
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

    // Clean up expired entries every 60 seconds
    ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const expired = new Set<string>();
      // Only iterate if we have entries
      const entries = await this.storage.list<RateEntry>();
      for (const [key, entry] of entries) {
        if (now > entry.resetAt) expired.add(key);
      }
      if (expired.size > 0) {
        await this.storage.delete(Array.from(expired));
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
}
