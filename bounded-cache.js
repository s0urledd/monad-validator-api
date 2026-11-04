// src/bounded-cache.js - TTL cache with a hard size cap

/**
 * A Map-backed cache whose entries expire after `ttlMs` and whose size never
 * exceeds `max`: when it is full, the least recently used entry goes first.
 *
 * Several caches in this service are keyed by request input (validator IDs,
 * delegator addresses, pagination cursors). Without a cap, every distinct key
 * a caller sends stays in memory for the life of the process.
 */
export class BoundedCache {
  constructor({ max = 1000, ttlMs = 30_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, expires }, least recently used first
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() >= hit.expires) {
      this.map.delete(key);
      return undefined;
    }
    // Move to the most recently used end.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  /** The stored value without touching recency or expiry. */
  peek(key) {
    return this.map.get(key)?.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  delete(key) {
    this.map.delete(key);
  }

  /** Drop every expired entry. */
  sweep() {
    const now = Date.now();
    for (const [key, hit] of this.map) {
      if (now >= hit.expires) this.map.delete(key);
    }
  }

  get size() {
    return this.map.size;
  }
}
