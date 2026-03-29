// src/snapshot-job.js - Epoch-based Uptime Snapshot Indexer
// Triggered on every epoch transition by status-sync.js epoch watcher.
// Each epoch snapshot captures all uptime_events since the last snapshot.
// Data stored locally only (no API endpoints for now).
//
// Querying:
//   getCumulativeUptime(id, "30d")  → SUM where snapshot_ts >= 30 days ago
//   getCumulativeUptime(id, "90d")  → SUM where snapshot_ts >= 90 days ago
//   getCumulativeUptime(id, "all")  → SUM of everything

import {
  saveEpochSnapshotsBatch,
  getUptimeStatsSince,
  getEpochSnapshotExists,
  getLastSnapshotTimestamp,
} from "./db.js";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, ...args) {
  const current = logLevels[LOG_LEVEL] ?? 2;
  if ((logLevels[level] ?? 2) <= current) {
    const prefix = { error: "!", warn: "!", info: ">", debug: "?" }[level] || "";
    console.log("[snapshot]", prefix, ...args);
  }
}

/**
 * Take a snapshot for a specific epoch.
 * Aggregates all uptime_events since the last snapshot timestamp.
 * Called by the epoch watcher when epoch transitions.
 *
 * @param {number} epoch - The epoch number that just completed
 * @returns {number} Number of validators captured
 */
export function takeEpochSnapshot(epoch) {
  if (getEpochSnapshotExists(epoch)) {
    log("debug", `Epoch ${epoch} already snapshotted, skipping`);
    return 0;
  }

  // Get the timestamp of the last snapshot to know where to start
  const lastTs = getLastSnapshotTimestamp();
  // If no previous snapshot, capture everything in uptime_events
  const sinceTs = lastTs || 0;

  const rows = getUptimeStatsSince(sinceTs);
  if (rows.length === 0) {
    log("debug", `No events since ts=${sinceTs} for epoch ${epoch}, skipping`);
    return 0;
  }

  // Aggregate per validator
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.validator_id)) {
      map.set(r.validator_id, {
        validatorId: r.validator_id,
        secpAddress: r.secp_address,
        epoch,
        finalized: 0,
        timeout: 0,
      });
    }
    const entry = map.get(r.validator_id);
    if (r.event_type === "finalized") entry.finalized = r.count;
    else if (r.event_type === "timeout") entry.timeout = r.count;
  }

  const snapshots = Array.from(map.values());
  saveEpochSnapshotsBatch(snapshots);
  log("info", `Epoch ${epoch} snapshot saved: ${snapshots.length} validators`);
  return snapshots.length;
}
