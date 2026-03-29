// src/snapshot-job.js - Daily Uptime Snapshot Indexer
// Aggregates uptime_events into uptime_daily_snapshots.
// Each row = one day's incremental data per validator.
// Cumulative (all-time) = SUM of all rows for a validator.
// 30d / 90d = SUM of rows WHERE date >= N days ago.
// Data is stored locally only (no API endpoints for now).
//
// Safety guarantees:
// - Yesterday is ALWAYS re-snapshotted (not skipped) to catch midnight boundary
// - Backfill only skips days older than yesterday that are already snapshotted
// - Today's partial is updated hourly via ON CONFLICT UPDATE

import db, {
  getUptimeStatsForDate,
  saveDailySnapshotsBatch,
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

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function getYesterdayStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return toDateStr(d);
}

/**
 * Snapshot a specific date: reads uptime_events for that day,
 * aggregates per validator, writes/updates uptime_daily_snapshots.
 * Uses ON CONFLICT UPDATE so it's safe to call multiple times.
 */
export function snapshotDate(dateStr) {
  const rows = getUptimeStatsForDate(dateStr);
  if (rows.length === 0) {
    log("debug", `No events for ${dateStr}, skipping`);
    return 0;
  }

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.validator_id)) {
      map.set(r.validator_id, {
        validatorId: r.validator_id,
        secpAddress: r.secp_address,
        date: dateStr,
        finalized: 0,
        timeout: 0,
      });
    }
    const entry = map.get(r.validator_id);
    if (r.event_type === "finalized") entry.finalized = r.count;
    else if (r.event_type === "timeout") entry.timeout = r.count;
  }

  const snapshots = Array.from(map.values());
  saveDailySnapshotsBatch(snapshots);
  log("info", `Snapshot saved: ${dateStr} - ${snapshots.length} validators`);
  return snapshots.length;
}

/**
 * Find days in uptime_events that have NO snapshot yet.
 * Excludes today and yesterday (handled separately with forced re-snapshot).
 */
function getUnsnapshotedOlderDates() {
  const todayStr = toDateStr(new Date());
  const yesterdayStr = getYesterdayStr();
  const rows = db.prepare(`
    SELECT DISTINCT date(timestamp, 'unixepoch') as day
    FROM uptime_events
    WHERE date(timestamp, 'unixepoch') < ?
      AND date(timestamp, 'unixepoch') != ?
      AND date(timestamp, 'unixepoch') NOT IN (
        SELECT DISTINCT date FROM uptime_daily_snapshots
      )
    ORDER BY day ASC
  `).all(yesterdayStr, todayStr);
  return rows.map(r => r.day);
}

/**
 * Backfill older days that are missing snapshots entirely.
 */
export function backfillMissingDays() {
  const missing = getUnsnapshotedOlderDates();
  if (missing.length === 0) return;

  log("info", `Backfilling ${missing.length} missing day(s): ${missing.join(", ")}`);
  for (const dateStr of missing) {
    try {
      snapshotDate(dateStr);
    } catch (err) {
      log("error", `Backfill failed for ${dateStr}:`, err.message);
    }
  }
}

/**
 * Main snapshot cycle (runs hourly):
 * 1. Backfill any older missing days
 * 2. Always re-snapshot yesterday (catches midnight boundary events)
 * 3. Update today's partial
 */
function runSnapshotCycle() {
  // 1. Backfill older missing days
  backfillMissingDays();

  // 2. Always re-snapshot yesterday (ON CONFLICT UPDATE ensures latest data)
  try {
    snapshotDate(getYesterdayStr());
  } catch (err) {
    log("error", `Yesterday snapshot failed:`, err.message);
  }

  // 3. Update today's partial
  try {
    snapshotDate(toDateStr(new Date()));
  } catch (err) {
    log("debug", `Today's partial snapshot failed: ${err.message}`);
  }
}

/**
 * Start the daily snapshot scheduler.
 * Runs immediately on startup, then every hour.
 */
export function startSnapshotJob() {
  log("info", "Daily uptime snapshot job started");

  runSnapshotCycle();

  const INTERVAL_MS = 3600000; // 1 hour
  setInterval(runSnapshotCycle, INTERVAL_MS);
}
