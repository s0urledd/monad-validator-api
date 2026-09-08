// src/index.js - Main API Server
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import validatorRoutes from "./validators.js";
import stakingRoutes from "./staking-routes.js";
import { startPeriodicSync } from "./github-sync.js";
import { startStatusSync } from "./status-sync.js";
import { startEventIndexer } from "./event-indexer.js";
import { renderMetrics } from "./metrics.js";
import {
  getValidatorCount,
  getValidatorCountsByStatus,
  getIndexerStats,
  getIndexerCursor,
  getLastSnapshotEpoch,
  getLastSnapshotTimestamp,
  getMeasuredBlockTime,
  getUptimeEventBounds,
} from "./db.js";
import { rateLimit } from "./rate-limit.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

// ---------- Logging ----------
const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, ...args) {
  const current = logLevels[LOG_LEVEL] ?? 2;
  if ((logLevels[level] ?? 2) <= current) {
    const prefix = { error: "❌", warn: "⚠️", info: "ℹ️", debug: "🔍" }[level] || "";
    console.log("[api]", prefix, ...args);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The OpenAPI document is the single source of truth for what this service
// exposes: it is served as-is, drives the docs page, and generates the endpoint
// listing below, so the three cannot drift apart.
let openapi = null;
try {
  openapi = JSON.parse(fs.readFileSync(path.join(__dirname, "openapi.json"), "utf8"));
} catch (err) {
  console.error("[api] ⚠️ Could not load openapi.json:", err.message);
}

// A plain-text rendering of the spec for LLM agents, per llmstxt.org. Built
// once at startup from the same document that drives the docs page, so it
// describes exactly what the server serves.
function llmsTxtFromSpec() {
  if (!openapi) return "# Monad Validator & Staking Data API\n\nSpec unavailable.\n";
  const info = openapi.info || {};
  const lines = [];
  lines.push(`# ${info.title || "Monad Validator & Staking Data API"}`, "");
  if (info.summary) lines.push(`> ${info.summary}`, "");
  if (info.description) lines.push(info.description.trim(), "");

  const servers = (openapi.servers || []).filter((s) => !/localhost/.test(s.url));
  if (servers.length) {
    lines.push("## Base URLs", "");
    for (const s of servers) lines.push(`- ${s.url}${s.description ? ` (${s.description})` : ""}`);
    lines.push("");
  }

  lines.push(
    "## Conventions",
    "",
    "- Every endpoint is GET and returns JSON with a top-level `success` boolean.",
    "- No authentication. Staking routes allow 60 requests per minute per IP and return `X-RateLimit-*` headers; validator routes are unmetered.",
    "- Validators are addressed by numeric ID or secp256k1 compressed public key.",
    "- Monetary values are numbers in MON, not strings.",
    "- Uptime endpoints take `?window=` (hours, rolling raw events) or `?period=30d|90d|all` (permanent epoch snapshots).",
    "- The full OpenAPI 3.1 document is at /monad-api/openapi.json and a live reference at /.",
    ""
  );

  const byTag = {};
  for (const [route, item] of Object.entries(openapi.paths || {})) {
    const op = item.get;
    if (!op) continue;
    (byTag[op.tags?.[0] || "Other"] ||= []).push({ route, op });
  }
  const order = (openapi.tags || []).map((t) => t.name);
  const tags = Object.keys(byTag).sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)
  );

  lines.push("## Endpoints", "");
  for (const tag of tags) {
    const tagDesc = (openapi.tags || []).find((t) => t.name === tag)?.description;
    lines.push(`### ${tag}`, "");
    if (tagDesc) lines.push(tagDesc, "");
    for (const { route, op } of byTag[tag]) {
      const params = (op.parameters || [])
        .map((p) => (p.$ref ? p.$ref.split("/").pop() : p.name))
        .filter(Boolean);
      const desc = (op.description || "").replace(/\s+/g, " ").trim();
      lines.push(`- GET ${route}: ${op.summary || ""}${params.length ? ` (params: ${params.join(", ")})` : ""}`);
      if (desc) lines.push(`  ${desc}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
const LLMS_TXT = llmsTxtFromSpec();

function endpointListFromSpec() {
  if (!openapi?.paths) return {};
  const groups = {};
  for (const [route, item] of Object.entries(openapi.paths)) {
    const op = item.get;
    if (!op) continue;
    const tag = op.tags?.[0] || "Other";
    (groups[tag] ||= {})[`GET ${route}`] = op.summary || "";
  }
  return groups;
}

// ---------- Express Setup ----------
const app = express();

// Behind nginx every connection arrives from the loopback address, so without
// this req.ip is 127.0.0.1 for everyone and the rate limiter degrades into one
// shared bucket that a single caller can exhaust for the whole internet.
//
// Trusting only loopback rather than `true` matters: `true` accepts whatever
// X-Forwarded-For a client sends, which lets anyone forge an address and slip
// the limit entirely. Restricting trust to the local proxy means the header is
// honoured only when nginx set it.
app.set("trust proxy", process.env.TRUST_PROXY || "loopback");

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    log("debug", `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// ---------- Routes ----------

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    validators_loaded: getValidatorCount()
  });
});

// Prometheus scrape target. Kept at the root under its conventional name, and
// outside the staking rate limiter, since a scraper hits it every 15-30s.
app.get("/metrics", (req, res) => {
  try {
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(renderMetrics());
  } catch (err) {
    log("error", "Metrics render failed:", err.message);
    res.status(500).type("text/plain").send("# metrics unavailable\n");
  }
});

// Agent-readable description of the API.
app.get("/llms.txt", (req, res) => {
  res.type("text/plain; charset=utf-8").send(LLMS_TXT);
});

// Data freshness. Everything here is read from SQLite, so it answers "is the
// data current" without depending on the node being reachable.
app.get("/monad-api/status", (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const lastSnapTs = getLastSnapshotTimestamp();
    const bounds = getUptimeEventBounds();
    const cursor = getIndexerCursor("staking_events_last_block");
    const idx = getIndexerStats();
    const blockTime = getMeasuredBlockTime();

    res.json({
      success: true,
      network: process.env.NETWORK || "unknown",
      now_utc: new Date(now * 1000).toISOString(),
      validators: { total: getValidatorCount(), ...getValidatorCountsByStatus() },
      uptime_events: {
        count: bounds?.count ?? 0,
        oldest_utc: bounds?.oldest ? new Date(bounds.oldest * 1000).toISOString() : null,
        newest_utc: bounds?.newest ? new Date(bounds.newest * 1000).toISOString() : null,
        seconds_since_newest: bounds?.newest ? now - bounds.newest : null,
      },
      snapshots: {
        last_epoch: getLastSnapshotEpoch(),
        last_utc: lastSnapTs ? new Date(lastSnapTs * 1000).toISOString() : null,
        seconds_since_last: lastSnapTs ? now - lastSnapTs : null,
        measured_block_time: blockTime ? parseFloat(blockTime.toFixed(4)) : null,
      },
      event_indexer: {
        last_block: cursor !== null ? Number(cursor) : null,
        events: idx.events,
        reward_rows: idx.reward_rows,
        first_event_block: idx.first_event_block,
        last_event_block: idx.last_event_block,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// OpenAPI document
app.get("/monad-api/openapi.json", (req, res) => {
  if (!openapi) return res.status(503).json({ success: false, error: "Spec unavailable" });
  res.json(openapi);
});

// Documentation site, also served from the root below once the API routes
// have had their chance to match.
app.use("/monad-api/docs", express.static(path.join(__dirname, "public")));

// API info, generated from the spec so it cannot drift from the routes
app.get("/monad-api", (req, res) => {
  res.json({
    name: openapi?.info?.title || "Monad Validator API",
    version: openapi?.info?.version || "2.1.0",
    documentation: "/monad-api/docs",
    openapi: "/monad-api/openapi.json",
    endpoints: endpointListFromSpec(),
  });
});

// Routes - /validators gizli endpoint (sadece sen kullan)
app.use("/monad-api/validators", validatorRoutes);
app.use("/monad-api/validator", validatorRoutes);

// Staking & Delegation routes (rate limited + 60s timeout for heavy RPC calls)
app.use("/monad-api/staking", rateLimit({ windowMs: 60_000, max: 60, timeoutMs: 60_000 }), stakingRoutes);

// Landing page at the root. Mounted after the API routes so it can only ever
// serve paths they did not claim.
app.use("/", express.static(path.join(__dirname, "public")));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Not Found",
    hint: "Try GET /monad-api for available endpoints"
  });
});

// Error handler
app.use((err, req, res, next) => {
  log("error", "Unhandled error:", err.message);
  res.status(500).json({
    success: false,
    error: "Internal Server Error"
  });
});

// ---------- Startup ----------
app.listen(PORT, HOST, () => {
  log("info", `🚀 Monad Validator API running on http://${HOST}:${PORT}`);
  log("info", `📋 Public endpoints: /monad-api/validator/... & /monad-api/staking/...`);
  log("info", `🔒 Hidden endpoint: /monad-api/validators (list all)`);
  
  startPeriodicSync();
  startStatusSync();
  startEventIndexer();

  log("info", `✅ Server ready!`);
});

process.on("SIGINT", () => {
  log("info", "Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("info", "Shutting down...");
  process.exit(0);
});
