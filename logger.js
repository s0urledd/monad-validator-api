// src/logger.js - Uptime Logger
import dotenv from "dotenv";
dotenv.config();

import { spawn } from "child_process";
import {
  insertUptimeEventsBatch,
  cleanupOldEvents,
  normalizeAddress,
  getAllValidators
} from "./db.js";

const JOURNAL_UNIT = (process.env.JOURNAL_UNIT || "monad-ledger-tail").trim();
const RETENTION_HOURS = Number(process.env.UPTIME_RETENTION_HOURS || 24);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const CLEANUP_INTERVAL_MS = 3600000;

// ---------- Logging ----------
const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, ...args) {
  const current = logLevels[LOG_LEVEL] ?? 2;
  if ((logLevels[level] ?? 2) <= current) {
    const prefix = { error: "❌", warn: "⚠️", info: "ℹ️", debug: "🔍" }[level] || "";
    console.log(`[logger]`, prefix, ...args);
  }
}

// ---------- In-memory validator cache ----------
let validatorCache = new Map();
let cacheLastUpdate = 0;
const CACHE_TTL_MS = 60000;

function refreshCache() {
  const now = Date.now();
  if (now - cacheLastUpdate > CACHE_TTL_MS) {
    validatorCache.clear();
    const validators = getAllValidators();
    for (const v of validators) {
      validatorCache.set(v.secp_address, v.id);
    }
    cacheLastUpdate = now;
    log("debug", `Cache refreshed: ${validatorCache.size} validators`);
  }
}

function getValidatorIdFromCache(author) {
  refreshCache();
  const normalized = normalizeAddress(author);
  return validatorCache.get(normalized) || null;
}

// ---------- Log Parser ----------
class UptimeLogger {
  constructor() {
    this.chunkBuffer = "";
    this.eventBuffer = [];
    this.flushIntervalMs = 1000;
    this.lastFlush = Date.now();
    this.processedCount = 0;
    this.lastRoundSeen = new Map();
  }

  parseLogLine(line) {
    try {
      const journalEntry = JSON.parse(line.trim());
      
      const messageStr = journalEntry.MESSAGE;
      if (!messageStr) return null;
      
      const inner = JSON.parse(messageStr);
      const fields = inner.fields || {};
      
      const kind = fields.message;
      if (kind !== "finalized_block" && kind !== "timeout") return null;
      
      const round = Number(fields.round);
      if (isNaN(round) || round < 0) return null;
      
      const seqNum = fields.seq_num ? Number(fields.seq_num) : null;
      
      const author = fields.author || "";
      if (!author) return null;
      
      const timestamp = inner.timestamp 
        ? Math.floor(new Date(inner.timestamp).getTime() / 1000)
        : Math.floor(Date.now() / 1000);
      
      return {
        eventType: kind === "finalized_block" ? "finalized" : "timeout",
        round,
        seqNum,
        author,
        timestamp
      };
    } catch (err) {
      log("debug", "Parse error:", err.message);
      return null;
    }
  }

  async handleParsed(parsed) {
    const validatorId = getValidatorIdFromCache(parsed.author);
    if (!validatorId) {
      log("debug", `Unknown validator: ${parsed.author.slice(0, 16)}...`);
      return;
    }

    const lastRound = this.lastRoundSeen.get(validatorId) || -1;
    if (parsed.round <= lastRound) return;
    this.lastRoundSeen.set(validatorId, parsed.round);

    this.eventBuffer.push({
      validatorId,
      round: parsed.round,
      seqNum: parsed.seqNum,
      eventType: parsed.eventType,
      timestamp: parsed.timestamp
    });

    if (Date.now() - this.lastFlush > this.flushIntervalMs) {
      await this.flush();
    }
  }

  async flush() {
    if (this.eventBuffer.length === 0) return;

    const batch = this.eventBuffer.splice(0);
    try {
      insertUptimeEventsBatch(batch);
      this.processedCount += batch.length;
      log("debug", `Flushed ${batch.length} events (total: ${this.processedCount})`);
    } catch (err) {
      log("error", "Batch insert failed:", err.message);
    }
    this.lastFlush = Date.now();
  }

  async start() {
    log("info", "🚀 Uptime Logger starting...");
    log("info", `📡 Journal unit: ${JOURNAL_UNIT}`);
    log("info", `🗑️ Retention: ${RETENTION_HOURS} hours`);

    refreshCache();
    if (validatorCache.size === 0) {
      log("warn", "No validators in cache! Run github-sync first.");
    } else {
      log("info", `📋 Loaded ${validatorCache.size} validators`);
    }

    setInterval(() => {
      const deleted = cleanupOldEvents(RETENTION_HOURS);
      if (deleted > 0) log("info", `🧹 Cleaned up ${deleted} old events`);
    }, CLEANUP_INTERVAL_MS);

    setInterval(() => this.flush(), this.flushIntervalMs);

    let jc;
    try {
      jc = spawn("journalctl", [
        "-u", JOURNAL_UNIT,
        "--no-pager",
        "-o", "json",
        "--since", "now",
        "--follow"
      ], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      log("error", "Failed to start journalctl:", e.message);
      process.exit(1);
    }

    jc.stdout.on("data", async (data) => {
      this.chunkBuffer += data.toString();
      const lines = this.chunkBuffer.split("\n");
      this.chunkBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = this.parseLogLine(line);
        if (parsed) {
          await this.handleParsed(parsed);
        }
      }
    });

    jc.stderr.on("data", (d) => log("error", "journalctl stderr:", d.toString()));
    jc.on("close", (code) => {
      log("error", `journalctl exited with code ${code}`);
      setTimeout(() => this.start(), 5000);
    });

    setInterval(() => {
      log("info", `📊 Stats: ${this.processedCount} events processed`);
    }, 60000);

    process.on("SIGINT", async () => {
      log("info", "Shutting down...");
      await this.flush();
      process.exit(0);
    });
  }
}

const logger = new UptimeLogger();
logger.start().catch(err => {
  log("error", "Logger startup failed:", err.message);
  process.exit(1);
});
