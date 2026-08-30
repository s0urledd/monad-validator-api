// src/index.js - Main API Server
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import validatorRoutes from "./validators.js";
import stakingRoutes from "./staking-routes.js";
import { startPeriodicSync } from "./github-sync.js";
import { startStatusSync } from "./status-sync.js";
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

// API info
app.get("/monad-api", (req, res) => {
  res.json({
    name: "Monad Validator API",
    version: "2.0.0",
    endpoints: {
      validators: {
        "GET /monad-api/validator/:id": "Get validator by ID (1, 2, 3...)",
        "GET /monad-api/validator/:address": "Get validator by Secp address",
        "GET /monad-api/validator/uptime/": "All validators uptime (?period= & ?limit= for a leaderboard)",
        "GET /monad-api/validator/uptime/:id": "Single validator uptime",
        "GET /monad-api/validator/uptime/:id/history": "Validator round history",
        "GET /monad-api/validator/:id/health": "Validator health state for monitoring",
        "GET /monad-api/validator/network/uptime": "Network-wide uptime per epoch",
      },
      staking: {
        "GET /monad-api/staking/epoch": "Current epoch info",
        "GET /monad-api/staking/pool": "Total staked, bonded tokens & APR",
        "GET /monad-api/staking/validator-set": "Active set + who enters/leaves next epoch",
        "GET /monad-api/staking/proposer": "Current block proposer",
        "GET /monad-api/staking/validator/:valId": "On-chain validator data (stake, commission, rewards)",
        "GET /monad-api/staking/validator/:valId/delegators": "List all delegators of a validator",
        "GET /monad-api/staking/delegator/:address": "All delegations & rewards for an address",
      },
    },
    query_params: {
      uptime: {
        window: "Hours window (1-168, default 24) — rolling, from raw events",
        period: "Cumulative from epoch snapshots: '30d', '90d' or 'all'",
        sort: "Sort by: 'uptime' (desc) or 'id' (asc)",
      },
      history: {
        limit: "Number of rounds (1-50, default 49)",
      },
    },
  });
});

// Routes - /validators gizli endpoint (sadece sen kullan)
app.use("/monad-api/validators", validatorRoutes);
app.use("/monad-api/validator", validatorRoutes);

// Staking & Delegation routes (rate limited + 60s timeout for heavy RPC calls)
app.use("/monad-api/staking", rateLimit({ windowMs: 60_000, max: 60, timeoutMs: 60_000 }), stakingRoutes);

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
