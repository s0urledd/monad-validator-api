// src/github-sync.js - Sync validator metadata from GitHub
import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { upsertValidator, getValidatorCount, normalizeAddress, getValidatorById } from "./db.js";

const NETWORK = process.env.NETWORK || "testnet";
const GITHUB_API_URL = `https://api.github.com/repos/monad-developers/validator-info/contents/${NETWORK}`;
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/monad-developers/validator-info/main/${NETWORK}`;

const SYNC_INTERVAL_MS = Number(process.env.METADATA_SYNC_INTERVAL_MS || 3600000);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

// ---------- Logging ----------
const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, ...args) {
  const current = logLevels[LOG_LEVEL] ?? 2;
  if ((logLevels[level] ?? 2) <= current) {
    const prefix = { error: "❌", warn: "⚠️", info: "ℹ️", debug: "🔍" }[level] || "";
    console.log(`[github-sync]`, prefix, ...args);
  }
}

// ---------- GitHub Fetch ----------
async function fetchValidatorList() {
  log("debug", `Fetching validator list from GitHub API...`);
  
  try {
    const res = await fetch(GITHUB_API_URL, {
      headers: { 
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "monad-validator-api"
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const files = await res.json();
    // .json dosyalarını filtrele
    return files.filter(f => f.name.endsWith(".json")).map(f => f.name.replace(".json", ""));
  } catch (err) {
    log("error", "Failed to fetch validator list:", err.message);
    return [];
  }
}

async function fetchValidatorInfo(blsKey) {
  const url = `${GITHUB_RAW_BASE}/${blsKey}.json`;
  log("debug", `Fetching validator: ${blsKey.slice(0, 16)}...`);
  
  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    log("warn", `Failed to fetch validator ${blsKey.slice(0, 16)}...:`, err.message);
    return null;
  }
}

// ---------- Sync Logic ----------
async function syncValidators() {
  log("info", "Starting validator metadata sync...");
  const startTime = Date.now();
  
  const blsKeys = await fetchValidatorList();
  log("info", `Found ${blsKeys.length} validator files on GitHub`);
  
  if (blsKeys.length === 0) {
    log("warn", "No validators found, skipping sync");
    return { synced: 0, failed: 0, total: getValidatorCount() };
  }
  
  let synced = 0;
  let failed = 0;
  
  for (const blsKey of blsKeys) {
    const info = await fetchValidatorInfo(blsKey);
    
    if (info && info.id) {
      try {
        // Use explicit secp from GitHub JSON if available.
        // Never overwrite an existing on-chain secp_address with a BLS key fallback —
        // that breaks uptime tracking (logger.js matches log author against secp_address).
        const secpFromGithub = info.secp ? normalizeAddress(info.secp) : null;
        const existing = getValidatorById(info.id);
        let secpAddress;
        if (secpFromGithub) {
          secpAddress = secpFromGithub;
        } else if (existing && existing.secp_address) {
          secpAddress = existing.secp_address;  // preserve on-chain secp
        } else {
          secpAddress = normalizeAddress(blsKey);  // last resort for brand new validators
        }

        upsertValidator({
          id: info.id,
          secp_address: secpAddress,
          bls_public_key: info.bls || blsKey,
          name: info.name || `Validator ${info.id}`,
          website: info.website || null,
          description: info.description || null,
          logo_url: info.logo || null,
          raw_json: JSON.stringify(info)
        });
        
        synced++;
        log("debug", `Synced #${info.id}: ${info.name || "unnamed"}`);
      } catch (err) {
        log("error", `Failed to upsert validator #${info.id}:`, err.message);
        failed++;
      }
    } else {
      failed++;
    }
    
    // Rate limit koruması
    await new Promise(r => setTimeout(r, 50));
  }
  
  const elapsed = Date.now() - startTime;
  log("info", `Sync complete: ${synced} synced, ${failed} failed (${elapsed}ms)`);
  log("info", `Total validators in DB: ${getValidatorCount()}`);
  
  return { synced, failed, total: getValidatorCount() };
}

// ---------- Scheduled Sync ----------
let syncInterval = null;

export function startPeriodicSync() {
  syncValidators().catch(err => log("error", "Initial sync failed:", err.message));
  
  syncInterval = setInterval(() => {
    syncValidators().catch(err => log("error", "Periodic sync failed:", err.message));
  }, SYNC_INTERVAL_MS);
  
  log("info", `Periodic sync scheduled every ${SYNC_INTERVAL_MS / 1000 / 60} minutes`);
}

export function stopPeriodicSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// ---------- CLI Mode ----------
const isMain = process.argv[1]?.includes("github-sync");
if (isMain) {
  syncValidators()
    .then(result => {
      console.log("\n✅ Sync result:", result);
      process.exit(0);
    })
    .catch(err => {
      console.error("❌ Sync failed:", err);
      process.exit(1);
    });
}

export { syncValidators };
