// src/status-sync.js - Sync validator status from staking precompile
import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import { getAllValidators, updateAllValidatorStatuses, updateAllValidatorStakingData, upsertValidator, normalizeAddress } from "./db.js";

const MONAD_RPC_URL = process.env.MONAD_RPC_URL || "http://127.0.0.1:8080";
const SYNC_INTERVAL_MS = Number(process.env.STATUS_SYNC_INTERVAL_MS || 3600000);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const STAKING_ADDRESS = "0x0000000000000000000000000000000000001000";

const STAKING_ABI = [
  "function getConsensusValidatorSet(uint32 startIndex) external returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getExecutionValidatorSet(uint32 startIndex) external returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getSnapshotValidatorSet(uint32 startIndex) external returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getValidator(uint64 valId) external returns (tuple(address auth_address, uint256 flags, uint256 stake, uint256 acc_reward_per_token, uint256 commission, uint256 unclaimed_rewards, uint256 consensus_stake, uint256 consensus_commission, uint256 snapshot_stake, uint256 snapshot_commission, bytes secp_pubkey, bytes bls_pubkey))",
];

// ---------- Logging ----------
const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, ...args) {
  const current = logLevels[LOG_LEVEL] ?? 2;
  if ((logLevels[level] ?? 2) <= current) {
    const prefix = { error: "❌", warn: "⚠️", info: "ℹ️", debug: "🔍" }[level] || "";
    console.log("[status-sync]", prefix, ...args);
  }
}

// ---------- Precompile Queries ----------
async function fetchValidatorSet(contract, setType) {
  const methodMap = {
    consensus: "getConsensusValidatorSet",
    execution: "getExecutionValidatorSet",
    snapshot: "getSnapshotValidatorSet",
  };
  const method = methodMap[setType];
  if (!method) throw new Error(`Unknown set type: ${setType}`);

  const ids = [];
  let startIndex = 0;
  let isDone = false;

  while (!isDone) {
    const result = await contract[method].staticCall(startIndex);
    isDone = result[0];
    startIndex = Number(result[1]);
    const valIds = result[2].map((id) => Number(id));
    ids.push(...valIds);
    log("debug", `${setType} page: got ${valIds.length} IDs, isDone=${isDone}`);
  }

  return new Set(ids);
}

// ---------- Sync Logic ----------
async function syncStatuses() {
  log("info", "Starting validator status sync...");
  const startTime = Date.now();

  let provider;
  try {
    provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
    await provider.getBlockNumber();
  } catch (err) {
    log("error", `Cannot connect to RPC (${MONAD_RPC_URL}):`, err.message);
    return { updated: 0, error: err.message };
  }

  const contract = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, provider);

  let consensusSet, executionSet, snapshotSet;
  try {
    [consensusSet, executionSet, snapshotSet] = await Promise.all([
      fetchValidatorSet(contract, "consensus"),
      fetchValidatorSet(contract, "execution"),
      fetchValidatorSet(contract, "snapshot"),
    ]);
    log("info", `Sets fetched - consensus: ${consensusSet.size}, execution: ${executionSet.size}, snapshot: ${snapshotSet.size}`);
  } catch (err) {
    log("error", "Failed to fetch validator sets:", err.message);
    return { updated: 0, error: err.message };
  }

  // DB'de olmayan on-chain validator'leri kaydet
  const allOnChainIds = new Set([...consensusSet, ...executionSet, ...snapshotSet]);
  const existingIds = new Set(getAllValidators().map((v) => v.id));
  const missingIds = [...allOnChainIds].filter((id) => !existingIds.has(id));

  if (missingIds.length > 0) {
    log("info", `Found ${missingIds.length} on-chain validators not in DB, fetching details...`);
    for (const valId of missingIds) {
      try {
        const info = await contract.getValidator.staticCall(valId);
        const secpHex = normalizeAddress(info.secp_pubkey);
        const blsHex = normalizeAddress(info.bls_pubkey);
        upsertValidator({
          id: valId,
          secp_address: secpHex,
          bls_public_key: blsHex,
          name: `Validator #${valId}`,
          website: null,
          description: null,
          logo_url: null,
          raw_json: JSON.stringify({ id: valId, source: "on-chain" }),
        });
        log("debug", `Registered on-chain validator #${valId}`);
      } catch (err) {
        log("warn", `Failed to fetch on-chain validator #${valId}:`, err.message);
      }
    }
  }

  const validators = getAllValidators();
  const statusMap = {};

  for (const v of validators) {
    if (consensusSet.has(v.id)) {
      statusMap[v.id] = "active";
    } else if (snapshotSet.has(v.id) || executionSet.has(v.id)) {
      statusMap[v.id] = "pending";
    } else {
      statusMap[v.id] = "inactive";
    }
  }

  try {
    updateAllValidatorStatuses(statusMap);
  } catch (err) {
    log("error", "Failed to update DB:", err.message);
    return { updated: 0, error: err.message };
  }

  // Fetch on-chain staking data (stake, commission, rewards) for all validators
  log("info", "Fetching on-chain staking data for all validators...");
  const stakingDataMap = {};
  const batchSize = 10;

  for (let i = 0; i < validators.length; i += batchSize) {
    const batch = validators.slice(i, i + batchSize);
    const promises = batch.map(async (v) => {
      try {
        const info = await contract.getValidator.staticCall(v.id);
        stakingDataMap[v.id] = {
          stake_wei: info.stake.toString(),
          commission_raw: info.commission.toString(),
          unclaimed_rewards_wei: info.unclaimed_rewards.toString(),
          consensus_stake_wei: info.consensus_stake.toString(),
        };
      } catch (err) {
        log("debug", `Failed to fetch staking data for validator #${v.id}: ${err.message}`);
      }
    });
    await Promise.all(promises);
  }

  try {
    updateAllValidatorStakingData(stakingDataMap);
    log("info", `Staking data updated for ${Object.keys(stakingDataMap).length} validators`);
  } catch (err) {
    log("error", "Failed to update staking data:", err.message);
  }

  const counts = { active: 0, pending: 0, inactive: 0 };
  for (const status of Object.values(statusMap)) {
    counts[status]++;
  }

  const elapsed = Date.now() - startTime;
  log("info", `Status sync complete: ${counts.active} active, ${counts.pending} pending, ${counts.inactive} inactive (${elapsed}ms)`);

  provider.destroy();
  return { updated: validators.length, counts, elapsed };
}

// ---------- Scheduled Sync ----------
let syncInterval = null;

export function startStatusSync() {
  syncStatuses().catch((err) => log("error", "Initial status sync failed:", err.message));

  syncInterval = setInterval(() => {
    syncStatuses().catch((err) => log("error", "Periodic status sync failed:", err.message));
  }, SYNC_INTERVAL_MS);

  log("info", `Status sync scheduled every ${SYNC_INTERVAL_MS / 1000 / 60} minutes`);
}

export function stopStatusSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// ---------- CLI Mode ----------
const isMain = process.argv[1]?.includes("status-sync");
if (isMain) {
  syncStatuses()
    .then((result) => {
      console.log("\n✅ Status sync result:", result);
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Status sync failed:", err);
      process.exit(1);
    });
}

export { syncStatuses };
