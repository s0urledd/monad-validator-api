// src/rate-limit.js - Lightweight IP-based rate limiter (no dependencies)

/**
 * Creates a rate limiter middleware.
 * @param {object} opts
 * @param {number} opts.windowMs   - Time window in ms (default 60s)
 * @param {number} opts.max        - Max requests per window (default 30)
 * @param {number} opts.timeoutMs  - Request timeout in ms (0 = disabled)
 */
export function rateLimit({ windowMs = 60_000, max = 30, timeoutMs = 0 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Cleanup stale entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now > entry.resetAt) hits.delete(ip);
    }
  }, 5 * 60_000).unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();

    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }

    entry.count++;

    // Rate limit headers
    const remaining = Math.max(0, max - entry.count);
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(remaining));
    res.set("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        success: false,
        error: "Too many requests",
        retry_after: retryAfter,
      });
    }

    // Request timeout
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (!res.headersSent) {
          res.status(504).json({ success: false, error: "Request timeout" });
        }
      }, timeoutMs);
      res.on("finish", () => clearTimeout(timer));
    }

    next();
  };
}
