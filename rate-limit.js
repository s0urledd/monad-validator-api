// src/rate-limit.js - Lightweight IP-based rate limiter (no dependencies)

/**
 * Creates a fixed-window, per-IP rate limiter middleware.
 *
 * The table of client addresses is bounded. Expired entries are swept on a
 * timer, and once `maxKeys` addresses are tracked the oldest entry is dropped
 * to make room, so a flood of distinct source addresses cannot grow memory
 * without limit. Entries are re-inserted whenever their window restarts, which
 * keeps the Map's insertion order close to oldest-window-first.
 *
 * @param {object} opts
 * @param {number} opts.windowMs   - Time window in ms (default 60s)
 * @param {number} opts.max        - Max requests per window (default 30)
 * @param {number} opts.timeoutMs  - Request timeout in ms (0 = disabled)
 * @param {number} opts.maxKeys    - Max client addresses tracked at once
 * @param {boolean} opts.headers   - Whether to send X-RateLimit-* headers
 */
export function rateLimit({
  windowMs = 60_000,
  max = 30,
  timeoutMs = 0,
  maxKeys = 50_000,
  headers = true,
} = {}) {
  const hits = new Map(); // ip -> { count, resetAt }, oldest window first

  const sweepEvery = Math.max(10_000, Math.min(windowMs, 60_000));
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now > entry.resetAt) hits.delete(ip);
    }
  }, sweepEvery).unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();

    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      if (entry) hits.delete(ip);
      while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }

    entry.count++;

    if (headers) {
      const remaining = Math.max(0, max - entry.count);
      res.set("X-RateLimit-Limit", String(max));
      res.set("X-RateLimit-Remaining", String(remaining));
      res.set("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
    }

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        success: false,
        error: "Too many requests",
        code: "RATE_LIMITED",
        retry_after: retryAfter,
      });
    }

    // Request timeout
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (!res.headersSent) {
          res.status(504).json({ success: false, error: "Request timeout", code: "TIMEOUT" });
        }
      }, timeoutMs);
      res.on("close", () => clearTimeout(timer));
    }

    next();
  };
}
