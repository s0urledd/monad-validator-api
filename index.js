// src/index.js - Main API Server
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import validatorRoutes from "./validators.js";
import { startPeriodicSync } from "./github-sync.js";
import { getValidatorCount } from "./db.js";

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

// Middleware
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
    version: "1.0.0",
    endpoints: {
      "GET /monad-api/validators": "List all validators",
      "GET /monad-api/validators/:id": "Get validator by ID (1, 2, 3...)",
      "GET /monad-api/validators/:address": "Get validator by Secp address (0x...)",
      "GET /monad-api/validators/uptime/:id": "Single validator uptime"
    },
    query_params: {
      uptime: {
        window: "Hours window (1-168, default 24)",
        limit: "Recent events limit (1-1000, default 100)"
      }
    }
  });
});

// Validator routes
app.use("/monad-api/validators", validatorRoutes);

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
  log("info", `📋 Endpoints: /monad-api/validators, /monad-api/validators/uptime/:id`);
  
  // Start GitHub metadata sync
  startPeriodicSync();
  log("info", `✅ Server ready!`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  log("info", "Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("info", "Shutting down...");
  process.exit(0);
});
