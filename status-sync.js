// src/status-sync.js - Sync validator status from staking precompile
import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import { getAllValidators, updateAllValidatorStatuses, updateChangedValidatorStates, updateAllValidatorStakingData, upsertValidator, normalizeAddress, updateValidatorSecp } from "./db.js";
import { takeEpochSnapshot } from "./snapshot-job.js";

const MONAD_RPC_URL = process.env.MONAD_RPC_URL || "http://127.0.0.1:8080";
const SYNC_INTERVAL_MS = Number(process.env.STATUS_SYNC_INTERVAL_MS || 3600000);
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const STAKING_ADDRESS = "0x0000000000000000000000000000000000001000";

const EPOCH_POLL_MS = Number(process.env.EPOCH_POLL_MS || 120000);
// Seats in the active set (ACTIVE_VALSET_SIZE in the staking contract).
const ACTIVE_VALSET_SIZE = Number(process.env.ACTIVE_VALSET_SIZE || 200);

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

async function readEpoch(contract) {
  const result = await contract.getEpoch.staticCall();
  return { epoch: Number(result[0]), inDelay: Boolean(result[1]) };
}

// The three sets and the delay flag have to describe the same moment: a
// boundary block or an epoch change between the reads would pair the sets of
// one epoch with the flag of another. The epoch is read before and after the
// sets; if it moved, everything is read once more.
async function readSets(contract) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await readEpoch(contract);
    const [consensus, execution, snapshot] = await Promise.all([
      fetchValidatorSet(contract, "consensus"),
      fetchValidatorSet(contract, "execution"),
      fetchValidatorSet(contract, "snapshot"),
    ]);
    const after = await readEpoch(contract);
    if (before.epoch === after.epoch && before.inDelay === after.inDelay) {
      const sets = { consensus, execution, snapshot, epoch: after.epoch, inDelay: after.inDelay };
      sets.now = sets.inDelay ? snapshot : consensus;
      sets.next = await nextSet(contract, sets);
      return sets;
    }
  }
  throw new Error("epoch state changed while reading the validator sets");
}

// The set of the next epoch. Inside the delay period the chain has already
// chosen it (consensus view). Before the boundary block it is a forecast of
// what the boundary block will do with the execution view: a validator that
// fell out of the stake rules stays listed there with its flags set and is
// dropped only then, and when more unflagged validators are listed than there
// are seats, only the largest by stake are taken.
async function nextSet(contract, sets) {
  if (sets.inDelay) return sets.consensus;

  const ids = [...sets.execution];
  const info = new Map();
  const batchSize = 20;
  for (let i = 0; i < ids.length; i += batchSize) {
    await Promise.all(
      ids.slice(i, i + batchSize).map(async (id) => {
        try {
          const v = await contract.getValidator.staticCall(id);
          info.set(id, { flags: v.flags, stake: v.stake });
        } catch (err) {
          log("debug", `getValidator(${id}) failed in the next-set forecast: ${err.message}`);
        }
      })
    );
  }

  // A validator that could not be read keeps the place it has now.
  const eligible = ids.filter((id) => {
    const v = info.get(id);
    return v ? v.flags === 0n : sets.consensus.has(id);
  });
  if (eligible.length <= ACTIVE_VALSET_SIZE) return new Set(eligible);

  if (eligible.some((id) => !info.has(id))) {
    throw new Error("could not read every validator needed to rank the next set");
  }
  eligible.sort((a, b) => {
    const sa = info.get(a).stake;
    const sb = info.get(b).stake;
    if (sa === sb) return a - b;
    return sa > sb ? -1 : 1;
  });
  return new Set(eligible.slice(0, ACTIVE_VALSET_SIZE));
}

// What the stored set_state values were computed from, for the routes that
// answer from them.
let _setInfo = null;

function rememberSets(sets) {
  _setInfo = {
    epoch: sets.epoch,
    inDelay: sets.inDelay,
    execution: [...sets.execution],
    at: Math.floor(Date.now() / 1000),
  };
}

export function getSetInfo() {
  return _setInfo;
}

// ---------- Set membership ----------
// Where a validator stands in the active set, from the three on-chain views.
// Outside the epoch delay period the consensus view is the set producing
// blocks, and the execution view is what the next boundary block picks from.
// Inside it the previous set (snapshot view) is still producing blocks and the
// consensus view already holds the set of the next epoch.
//   active   - in the set now and in the next one
//   leaving  - in the set now, not in the next one
//   joining  - not in the set now, in the next one
//   inactive - in neither
// Before the boundary block "next" is a forecast (see nextSet): stake can still
// move until then.
export function setStateOf(id, sets) {
  const now = sets.now.has(id);
  const next = sets.next.has(id);
  if (now) return next ? "active" : "leaving";
  return next ? "joining" : "inactive";
}

function statusOf(id, sets) {
  if (sets.consensus.has(id)) return "active";
  if (sets.snapshot.has(id) || sets.execution.has(id)) return "pending";
  return "inactive";
}

function buildStatusMaps(validators, sets) {
  const statusMap = {};
  const setStateMap = {};
  for (const v of validators) {
    statusMap[v.id] = statusOf(v.id, sets);
    setStateMap[v.id] = setStateOf(v.id, sets);
  }
  return { statusMap, setStateMap };
}

// The sets alone, without the stake data of the full sync, on every epoch
// poll: a validator crossing the stake threshold shows up within one poll
// instead of at the next hourly sync.
async function syncSets() {
  let provider;
  try {
    provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
    const contract = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, provider);
    const sets = await readSets(contract);

    // A validator the database has not seen yet is added by the full sync
    const validators = getAllValidators();
    const known = new Set(validators.map((v) => v.id));
    const isNew = (id) => !known.has(id);
    if ([...sets.consensus].some(isNew) || [...sets.execution].some(isNew) || [...sets.snapshot].some(isNew)) {
      log("info", "Set sync: a validator not in the database yet, running the full sync");
      await syncStatuses();
      return;
    }

    const { statusMap, setStateMap } = buildStatusMaps(validators, sets);
    const changed = updateChangedValidatorStates(statusMap, setStateMap);
    rememberSets(sets);
    log(changed > 0 ? "info" : "debug", `Set sync: ${changed} changed (consensus ${sets.consensus.size}, execution ${sets.execution.size}, snapshot ${sets.snapshot.size}, in delay: ${sets.inDelay})`);
  } catch (err) {
    log("warn", `Set sync failed: ${err.message}`);
  } finally {
    provider?.destroy();
  }
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

  let sets, consensusSet, executionSet, snapshotSet;
  try {
    sets = await readSets(contract);
    consensusSet = sets.consensus;
    executionSet = sets.execution;
    snapshotSet = sets.snapshot;
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
  const { statusMap, setStateMap } = buildStatusMaps(validators, sets);

  try {
    updateAllValidatorStatuses(statusMap, setStateMap);
    rememberSets(sets);
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
let _fullSyncWanted = false;

// One sync at a time. A full sync asked for while another one runs is not
// dropped: it starts as soon as that one ends.
function requestSync(full, label) {
  if (_syncing) {
    if (full) _fullSyncWanted = true;
    return;
  }
  _syncing = true;
  Promise.resolve()
    .then(() => (full ? syncStatuses() : syncSets()))
    .catch((err) => log("error", `${label} sync failed:`, err.message))
    .finally(() => {
      _syncing = false;
      if (_fullSyncWanted) {
        _fullSyncWanted = false;
        requestSync(true, "Deferred");
      }
    });
}

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

      requestSync(true, "Epoch-triggered");
    } else {
      requestSync(false, "Set");
    }
  } catch (err) {
    log("debug", `Epoch poll failed: ${err.message}`);
  }
}

// ---------- Scheduled Sync ----------
let syncInterval = null;

export function startStatusSync() {
  requestSync(true, "Initial");

  // Default periodic sync (fallback)
  syncInterval = setInterval(() => requestSync(true, "Periodic"), SYNC_INTERVAL_MS);

  // Epoch watcher: a full sync on an epoch or boundary change, the sets alone
  // on every other poll
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
