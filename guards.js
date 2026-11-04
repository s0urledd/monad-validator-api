// src/guards.js - Request limits, response caching, parameter parsing and
// error responses shared by the route modules.

import { rateLimit } from "./rate-limit.js";
import { BoundedCache } from "./bounded-cache.js";

// ---------- Logging ----------
// LOG_LEVEL is read at call time: this module is imported before index.js
// gets to run dotenv.config().
const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };
export function log(level, ...args) {
  const current = logLevels[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 2;
  if ((logLevels[level] ?? 2) <= current) {
    const prefix = { error: "❌", warn: "⚠️", info: "ℹ️", debug: "🔍" }[level] || "";
    console.log("[http]", prefix, ...args);
  }
}

function describe(err) {
  const text = err?.shortMessage || err?.message || String(err);
  return text.length > 500 ? text.slice(0, 500) + "…" : text;
}

// ---------- Error responses ----------
// Clients get a fixed message and a stable code. What actually went wrong
// (SQLite errors, ethers errors with library versions and request payloads)
// goes to the server log only.

export function sendError(res, status, code, error, extra = {}) {
  return res.status(status).json({ success: false, error, code, ...extra });
}

export function internalError(req, res, err) {
  log("error", `${req.method} ${req.baseUrl}${req.path} failed:`, describe(err));
  if (res.headersSent) return;
  return sendError(res, 500, "INTERNAL", "Internal Server Error");
}

export function upstreamError(req, res, err, error) {
  log("error", `${req.method} ${req.baseUrl}${req.path} upstream error:`, describe(err));
  if (res.headersSent) return;
  return sendError(res, 503, "UPSTREAM_ERROR", error);
}

// ---------- Parameter parsing ----------

const UINT64_MAX = (1n << 64n) - 1n;

/**
 * A validator ID from a path segment: digits only, inside the uint64 range the
 * precompile uses. IDs above 2^53 - 1 are refused as well, because every
 * response echoes the ID back as a JSON number, which cannot carry them
 * exactly. Validator IDs are assigned from 1 upwards, so no real one is near.
 */
export function parseId(value) {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return null;
  const n = BigInt(value);
  if (n < 1n || n > UINT64_MAX || n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(n);
}

/** A non-negative integer query parameter, or null. */
export function parseNonNegativeInt(value) {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/**
 * A page size. Missing or unparseable values fall back to the default, as
 * `Number(x) || fallback` always did here; the result is a whole number
 * clamped to [1, max].
 */
export function parseLimit(value, fallback, max) {
  const raw = Number(value);
  if (!raw) return fallback;
  return Math.min(Math.max(Math.floor(raw), 1), max);
}

/** A 20-byte hex address with its 0x prefix, in any letter case. */
export function isHexAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

// ---------- Rate limits ----------
// Abuse ceilings, set far above real traffic rather than sized to it. Peaks
// seen in production were 72 req/s from one client on the per-validator
// routes and 3 req/s on the all-validator ones.

/** Every validator route: cheap indexed lookups. */
export const lightLimit = rateLimit({ windowMs: 1_000, max: 300 });

/** Routes that aggregate over every validator, /metrics and /status. */
export const heavyLimit = rateLimit({ windowMs: 1_000, max: 50 });

/**
 * The two staking routes that fan out into many RPC calls per request
 * (delegators of a validator, delegations of an address). One budget shared
 * by both. Headers are left to the staking router's own limiter.
 */
export const fanoutLimit = rateLimit({ windowMs: 60_000, max: 60, headers: false });

// ---------- Concurrency gate ----------

/**
 * Lets at most `max` requests through at once, across all callers. Anything
 * beyond that is turned away immediately with 503 rather than queued, so a
 * burst cannot pile work up behind the node.
 */
export function concurrencyGate({ max = 8, retryAfterSeconds = 5 } = {}) {
  let active = 0;
  return (req, res, next) => {
    if (active >= max) {
      res.set("Retry-After", String(retryAfterSeconds));
      return sendError(res, 503, "BUSY", "Server busy, retry shortly", {
        retry_after: retryAfterSeconds,
      });
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  };
}

/** One gate shared by the fan-out routes. */
export const fanoutGate = concurrencyGate({ max: 8, retryAfterSeconds: 5 });

// ---------- Deadline ----------

/**
 * Gives the handler an AbortSignal at `res.locals.signal` that fires when the
 * deadline passes (the client then gets 504) or when the client disconnects.
 * Handlers check it between RPC batches, so abandoned work stops instead of
 * running to completion for nobody.
 */
export function deadline(ms) {
  return (req, res, next) => {
    const controller = new AbortController();
    res.locals.signal = controller.signal;
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent) sendError(res, 504, "TIMEOUT", "Request timeout");
    }, ms);
    res.on("close", () => {
      clearTimeout(timer);
      if (!res.writableFinished) controller.abort();
    });
    next();
  };
}

// ---------- Response cache ----------

const memoStore = new BoundedCache({ max: 512 });
setInterval(() => memoStore.sweep(), 60_000).unref();

// A pending computation stays shared until it settles, but never longer.
const PENDING_TTL_MS = 120_000;

/**
 * Return the cached result for `key`, or compute it. Results are kept for
 * `ttlMs`. Concurrent callers share a single computation: a synchronous one
 * cannot interleave on the event loop, and an asynchronous one is cached as
 * its promise from the moment it starts. Failures are never cached.
 */
export function memo(key, ttlMs, compute) {
  const hit = memoStore.get(key);
  if (hit !== undefined) return hit;

  const value = compute();
  if (value && typeof value.then === "function") {
    const shared = value.then(
      (result) => {
        memoStore.set(key, shared, ttlMs);
        return result;
      },
      (err) => {
        if (memoStore.peek(key) === shared) memoStore.delete(key);
        throw err;
      }
    );
    memoStore.set(key, shared, PENDING_TTL_MS);
    return shared;
  }

  memoStore.set(key, value, ttlMs);
  return value;
}
