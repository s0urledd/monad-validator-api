// src/status-sync.js - Sync validator status from staking precompile
import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import { getAllValidators, updateAllValidatorStatuses, updateAllValidatorStakingData, upsertValidator, normalizeAddress, updateValidatorSecp } from "./db.js";
import { takeEpochSnapshot } from "./snapshot-job.js";

const MONAD_RPC_URL = process.env.MONAD_RPC_URL || "http://127.0.0.1:8080";
const SYNC_INTERVAL_MS = Number(process.env.STATUS_SYNC_INTERVAL_MS || 3600000);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const STAKING_ADDRESS = "0x0000000000000000000000000000000000001000";

const EPOCH_POLL_MS = Number(process.env.EPOCH_POLL_MS || 120000);

const STAKING_ABI = [
  "function getConsensusValidatorSet(uint32 startIndex) external returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getExecutionValidatorSet(uint32 startIndex) external returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getSnapshotValidatorSet(uint32 startIndex) external returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getValidator(uint64 valId) external returns (address auth_address, uint256 flags, uint256 stake, uint256 acc_reward_per_token, uint256 commission, uint256 unclaimed_rewards, uint256 consensus_stake, uint256 consensus_commission, uint256 snapshot_stake, uint256 snapshot_commission, bytes secp_pubkey, bytes bls_pubkey)",
  "function getEpoch() external returns (uint64 epoch, bool inEpochDelayPeriod)",
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

  // Discover ALL on-chain validators (including inactive below threshold)
  const allSetIds = new Set([...consensusSet, ...executionSet, ...snapshotSet]);
  const maxSetId = Math.max(...allSetIds, 0);
  const existingIds = new Set(getAllValidators().map((v) => v.id));
  const maxKnownId = Math.max(maxSetId, ...existingIds, 0);

  // Scan from 1 to maxKnownId + buffer to find all validators
  const scanLimit = maxKnownId + 20;
  const missingIds = [];
  for (let id = 1; id <= scanLimit; id++) {
    if (!existingIds.has(id) && !allSetIds.has(id)) {
      missingIds.push(id);
    } else if (!existingIds.has(id) && allSetIds.has(id)) {
      missingIds.push(id);
    }
  }

  if (missingIds.length > 0) {
    log("info", `Scanning ${missingIds.length} potential validator IDs (1-${scanLimit})...`);
    let discovered = 0;
    const batchSize = 20;
    for (let i = 0; i < missingIds.length; i += batchSize) {
      const batch = missingIds.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (valId) => {
          try {
            const info = await contract.getValidator.staticCall(valId);
            // Valid validator has non-zero auth_address
            if (info.auth_address && info.auth_address !== ethers.ZeroAddress) {
              return { valId, info };
            }
            return null;
          } catch {
            return null;
          }
        })
      );
      for (const r of results) {
        if (!r) continue;
        const secpHex = normalizeAddress(r.info.secp_pubkey);
        const blsHex = normalizeAddress(r.info.bls_pubkey);
        upsertValidator({
          id: r.valId,
          secp_address: secpHex,
          bls_public_key: blsHex,
          name: `Validator #${r.valId}`,
          website: null,
          description: null,
          logo_url: null,
          raw_json: JSON.stringify({ id: r.valId, source: "on-chain" }),
        });
        discovered++;
        log("debug", `Discovered validator #${r.valId}`);
      }
    }
    if (discovered > 0) {
      log("info", `Discovered ${discovered} new validators from on-chain scan`);
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

  let secpUpdated = 0;
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
          snapshot_stake_wei: info.snapshot_stake.toString(),
        };
        // Keep secp_address in sync with on-chain secp_pubkey.
        // This fixes cases where github-sync overwrote it with a BLS key fallback.
        const onChainSecp = normalizeAddress(info.secp_pubkey);
        if (onChainSecp && onChainSecp.length > 0 && onChainSecp !== v.secp_address) {
          updateValidatorSecp(v.id, onChainSecp);
          secpUpdated++;
          log("debug", `Updated secp_address for validator #${v.id}`);
        }
      } catch (err) {
        log("debug", `Failed to fetch staking data for validator #${v.id}: ${err.message}`);
      }
    });
    await Promise.all(promises);
  }
  if (secpUpdated > 0) {
    log("info", `Fixed secp_address for ${secpUpdated} validators from on-chain data`);
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

// ---------- Epoch Watcher ----------
let _lastEpoch = null;
let _lastDelayPeriod = null;
let _epochInterval = null;
let _syncing = false;

async function checkEpoch() {
  try {
    const provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
    const contract = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, provider);
    const result = await contract.getEpoch.staticCall();
    const epoch = Number(result[0]);
    const inDelay = result[1];
    provider.destroy();

    if (_lastEpoch === null) {
      _lastEpoch = epoch;
      _lastDelayPeriod = inDelay;
      return;
    }

    const epochChanged = epoch !== _lastEpoch;
    const boundaryPassed = inDelay && !_lastDelayPeriod;

    _lastEpoch = epoch;
    _lastDelayPeriod = inDelay;

    if (epochChanged || boundaryPassed) {
      const reason = epochChanged ? `epoch ${epoch - 1} → ${epoch}` : "boundary block passed";
      log("info", `Epoch watcher: ${reason}, triggering sync...`);

      // Snapshot uptime data for the completed epoch before syncing new state
      if (epochChanged) {
        try {
          takeEpochSnapshot(epoch - 1);
        } catch (err) {
          log("error", `Epoch snapshot failed for epoch ${epoch - 1}:`, err.message);
        }
      }

      if (!_syncing) {
        _syncing = true;
        syncStatuses()
          .catch((err) => log("error", "Epoch-triggered sync failed:", err.message))
          .finally(() => { _syncing = false; });
      }
    }
  } catch (err) {
    log("debug", `Epoch poll failed: ${err.message}`);
  }
}

// ---------- Scheduled Sync ----------
let syncInterval = null;

export function startStatusSync() {
  syncStatuses().catch((err) => log("error", "Initial status sync failed:", err.message));

  // Default periodic sync (fallback)
  syncInterval = setInterval(() => {
    if (!_syncing) {
      _syncing = true;
      syncStatuses()
        .catch((err) => log("error", "Periodic status sync failed:", err.message))
        .finally(() => { _syncing = false; });
    }
  }, SYNC_INTERVAL_MS);

  // Epoch watcher — polls every 60s, triggers sync on epoch/boundary change
  _epochInterval = setInterval(checkEpoch, EPOCH_POLL_MS);
  checkEpoch();

  log("info", `Status sync scheduled every ${SYNC_INTERVAL_MS / 1000 / 60}min + epoch watcher every ${EPOCH_POLL_MS / 1000}s`);
}

export function stopStatusSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (_epochInterval) {
    clearInterval(_epochInterval);
    _epochInterval = null;
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
