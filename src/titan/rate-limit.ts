import { isIP } from 'node:net';

/**
 * Per-peer token bucket for the HTTP API when it is deliberately exposed
 * (`CFR_ALLOW_REMOTE=1`). The API ships unauthenticated by design; a coarse
 * per-peer request budget is the only DoS guard that needs no auth story.
 * Loopback-only deployments (the default) never construct a limiter, so
 * local tooling can never throttle itself.
 */

export interface RateLimitOptions {
  /** Burst size: tokens available after a quiet period. */
  readonly capacity: number;
  /** Steady-state tokens per second of continued traffic. */
  readonly refillPerSec: number;
  /** Injectable clock (ms) for deterministic tests. */
  readonly now?: () => number;
  /** Cap on tracked peers; oldest entries are evicted first. */
  readonly maxPeers?: number;
}

export interface RateVerdict {
  readonly allowed: boolean;
  /** Seconds until a token would be available (0 when allowed). */
  readonly retryAfterSec: number;
}

const DEFAULT_MAX_PEERS = 1000;

interface Bucket {
  tokens: number;
  lastMs: number;
}

/** Canonicalize one IP for exact proxy matching, including IPv4-mapped IPv6. */
export function canonicalIp(address: string): string | null {
  const trimmed = address.trim();
  const family = isIP(trimmed);
  if (family === 0) return null;
  if (family === 4) return trimmed;

  // WHATWG URL canonicalizes IPv6 but does not accept a scope identifier.
  const zoneStart = trimmed.indexOf('%');
  const ip = zoneStart === -1 ? trimmed : trimmed.slice(0, zoneStart);
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  // The mapped prefix must be followed by exactly two hextets.
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(canonical)) {
    // Each mapped hextet is variable-width after URL normalization.
    const [high = '', low = ''] = canonical.slice(7).split(':');
    const upper = Number.parseInt(high, 16);
    const lower = Number.parseInt(low, 16);
    return [upper >>> 8, upper & 255, lower >>> 8, lower & 255].join('.');
  }
  return zoneStart === -1 ? canonical : canonical + trimmed.slice(zoneStart);
}

/** Group IPv6 peers by /64 so rotating interface identifiers share a bucket. */
export function normalizePeerAddress(address: string): string {
  const canonical = canonicalIp(address);
  if (canonical === null) return address.trim();
  if (!canonical.includes(':')) return canonical;
  const [ip = ''] = canonical.split('%', 1);
  const [left = '', right] = ip.split('::');
  const prefix = left === '' ? [] : left.split(':');
  const tail = right ? right.split(':') : [];
  const expanded = [
    ...prefix,
    ...Array<string>(8 - prefix.length - tail.length).fill('0'),
    ...tail,
  ];
  return `${expanded.slice(0, 4).join(':')}::/64`;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly maxPeers: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimitOptions) {
    this.capacity = Math.max(1, options.capacity);
    this.refillPerSec = Math.max(0.1, options.refillPerSec);
    this.now = options.now ?? Date.now;
    this.maxPeers = Math.max(1, options.maxPeers ?? DEFAULT_MAX_PEERS);
  }

  /**
   * Take `cost` tokens for `peer`; allowed while the bucket can pay.
   *
   * The cost is what the request will COST, not how many requests it is:
   * a route that pulls the complete upstream document charges more than
   * one that reads the local index. Charging one token per request let a
   * peer buy the whole upstream document with every token — the
   * published budget of ten requests a second bought TWENTY whole
   * documents a second, because a diff or a redline pulls two of them.
   */
  consume(peer: string, cost = 1): RateVerdict {
    const normalized = normalizePeerAddress(peer);
    const nowMs = this.now();
    const bucket = this.buckets.get(normalized) ?? { tokens: this.capacity, lastMs: nowMs };
    // Refill proportionally to elapsed time, capped at capacity.
    const elapsedSec = Math.max(0, (nowMs - bucket.lastMs) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.lastMs = nowMs;
    this.buckets.set(normalized, bucket);
    if (this.buckets.size > this.maxPeers) this.prune();

    const wanted = Math.max(1, cost);
    if (bucket.tokens >= wanted) {
      bucket.tokens -= wanted;
      return { allowed: true, retryAfterSec: 0 };
    }
    // A cost the bucket cannot hold must not make the route unreachable:
    // with a capacity of 5 and a cost of 10, zero of a thousand calls
    // were admitted, at any clock. A FULL bucket still admits one such
    // request and is emptied by it — the shortfall is not carried over.
    //
    // The escape has a price worth naming: a bucket SMALLER than the
    // cost buys one expensive request per refill interval, so a smaller
    // bucket buys MORE expensive requests than a larger one. The
    // published default (capacity 60, cost 10) never reaches this
    // branch — it is reachable only by configuring the bucket below the
    // route's own cost.
    if (wanted > this.capacity && bucket.tokens >= this.capacity) {
      bucket.tokens = 0;
      return { allowed: true, retryAfterSec: 0 };
    }
    // The wait is until the request becomes admissible: until the bucket
    // is full again when the cost exceeds the capacity, until it holds
    // the cost otherwise.
    const shortfall =
      wanted > this.capacity ? this.capacity - bucket.tokens : wanted - bucket.tokens;
    return { allowed: false, retryAfterSec: shortfall / this.refillPerSec };
  }

  /**
   * Drop the least-recently-seen peers once the map exceeds `maxPeers` —
   * bounding memory against peer-address floods (IPv6 spaces are huge).
   *
   * Evict down to 90% of `maxPeers` (rounded down, with a minimum of one)
   * to avoid sorting on every new peer under an address flood.
   */
  prune(): void {
    if (this.buckets.size <= this.maxPeers) return;
    const target = Math.max(1, Math.floor(this.maxPeers * 0.9));
    const entries = [...this.buckets.entries()].sort((a, b) => a[1].lastMs - b[1].lastMs);
    const toRemove = this.buckets.size - target;
    for (const [key] of entries.slice(0, toRemove)) {
      this.buckets.delete(key);
    }
  }
}
