// src/snapshot-job.js - Daily Uptime Snapshot Indexer
// Aggregates uptime_events into uptime_daily_snapshots.
// Each row = one day's incremental data per validator.
// Cumulative (all-time) = SUM of all rows for a validator.
// 30d / 90d = SUM of rows WHERE date >= N days ago.
// Data is stored locally only (no API endpoints for now).
//
// IMPORTANT: This job backfills ALL un-snapshotted days from uptime_events
// to ensure no data is lost even if the server was down for a period.

import db, {
  getUptimeStatsForDate,
  saveDailySnapshotsBatch,
  getSnapshotExists,
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

/**
 * Find all distinct dates in uptime_events that do NOT yet have
 * a snapshot. Excludes today (partial, handled separately).
 */
function getUnsnapshotedDates() {
  const todayStr = toDateStr(new Date());
  const rows = db.prepare(`
    SELECT DISTINCT date(timestamp, 'unixepoch') as day
    FROM uptime_events
    WHERE date(timestamp, 'unixepoch') < ?
      AND date(timestamp, 'unixepoch') NOT IN (
        SELECT DISTINCT date FROM uptime_daily_snapshots
      )
    ORDER BY day ASC
  `).all(todayStr);
  return rows.map(r => r.day);
}

/**
 * Snapshot a specific date: reads uptime_events for that day,
 * aggregates per validator (finalized + timeout counts),
 * writes one row per validator into uptime_daily_snapshots.
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
 * Snapshot today's partial data.
 * Overwrites each time so the latest partial is always available.
 */
export function snapshotToday() {
  const todayStr = toDateStr(new Date());
  try {
    snapshotDate(todayStr);
  } catch (err) {
    log("debug", `Today's partial snapshot failed: ${err.message}`);
  }
}

/**
 * Backfill: snapshot ALL days in uptime_events that are missing
 * from uptime_daily_snapshots. This ensures no data is ever lost,
 * even if the server was down or restarted mid-day.
 */
export function backfillMissingDays() {
  const missing = getUnsnapshotedDates();
  if (missing.length === 0) {
    log("debug", "No missing snapshots to backfill");
    return;
  }

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
 * Start the daily snapshot scheduler.
 * - On startup: backfill all missing days + snapshot today's partial
 * - Every hour: re-check missing days + update today's partial
 *
 * Runs BEFORE cleanup so no data is lost from uptime_events
 * retention window (48h default).
 */
export function startSnapshotJob() {
  log("info", "Daily uptime snapshot job started");

  // Initial run: catch up on anything we missed
  backfillMissingDays();
  snapshotToday();

  // Hourly: check for missing days + update today
  const INTERVAL_MS = 3600000; // 1 hour
  setInterval(() => {
    backfillMissingDays();
    snapshotToday();
  }, INTERVAL_MS);
}
