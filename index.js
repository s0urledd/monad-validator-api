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
import { getValidatorCount } from "./db.js";
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
