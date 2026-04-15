// src/db.js - SQLite Database Management
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data", "monad.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// ---------- Schema ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS validators (
    id INTEGER PRIMARY KEY,
    secp_address TEXT UNIQUE NOT NULL,
    bls_public_key TEXT,
    name TEXT,
    website TEXT,
    description TEXT,
    logo_url TEXT,
    raw_json TEXT,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS uptime_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    validator_id INTEGER NOT NULL,
    round INTEGER NOT NULL,
    seq_num INTEGER,
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    UNIQUE(validator_id, round)
  );

  CREATE INDEX IF NOT EXISTS idx_uptime_validator_time 
    ON uptime_events(validator_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_uptime_time 
    ON uptime_events(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_validators_secp
    ON validators(secp_address);

  CREATE TABLE IF NOT EXISTS uptime_epoch_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    validator_id INTEGER NOT NULL,
    secp_address TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    finalized_count INTEGER NOT NULL DEFAULT 0,
    timeout_count INTEGER NOT NULL DEFAULT 0,
    total_events INTEGER NOT NULL DEFAULT 0,
    uptime_percent REAL NOT NULL DEFAULT 0,
    snapshot_ts INTEGER DEFAULT (strftime('%s', 'now')),
    UNIQUE(validator_id, epoch)
  );

  CREATE INDEX IF NOT EXISTS idx_epoch_snapshots_validator
    ON uptime_epoch_snapshots(validator_id, epoch DESC);
  CREATE INDEX IF NOT EXISTS idx_epoch_snapshots_epoch
    ON uptime_epoch_snapshots(epoch DESC);
  CREATE INDEX IF NOT EXISTS idx_epoch_snapshots_ts
    ON uptime_epoch_snapshots(snapshot_ts DESC);
`);

// seq_num column yoksa ekle
try {
  db.exec(`ALTER TABLE uptime_events ADD COLUMN seq_num INTEGER`);
} catch (e) {
  // Column already exists
}

// status columns yoksa ekle
for (const col of [
  "status TEXT DEFAULT 'unknown'",
  "status_updated_at INTEGER",
  "stake_wei TEXT",
  "commission_raw TEXT",
  "unclaimed_rewards_wei TEXT",
  "consensus_stake_wei TEXT",
  "snapshot_stake_wei TEXT"
]) {
  try {
    db.exec(`ALTER TABLE validators ADD COLUMN ${col}`);
  } catch (e) {
    // Column already exists
  }
}

// ---------- Validator CRUD ----------
export function upsertValidator(data) {
  const stmt = db.prepare(`
    INSERT INTO validators (id, secp_address, bls_public_key, name, website, description, logo_url, raw_json, updated_at)
    VALUES (@id, @secp_address, @bls_public_key, @name, @website, @description, @logo_url, @raw_json, strftime('%s', 'now'))
    ON CONFLICT(id) DO UPDATE SET
      secp_address = @secp_address,
      bls_public_key = @bls_public_key,
      name = @name,
      website = @website,
      description = @description,
      logo_url = @logo_url,
      raw_json = @raw_json,
      updated_at = strftime('%s', 'now')
  `);
  return stmt.run(data);
}

export function getValidatorById(id) {
  return db.prepare("SELECT * FROM validators WHERE id = ?").get(id);
}

export function getValidatorByAddress(address) {
  const normalized = normalizeAddress(address);
  return db.prepare("SELECT * FROM validators WHERE secp_address = ?").get(normalized);
}

export function getAllValidators() {
  return db.prepare("SELECT * FROM validators ORDER BY id ASC").all();
}

export function getValidatorCount() {
  return db.prepare("SELECT COUNT(*) as count FROM validators").get().count;
}

export function getValidatorCountsByStatus() {
  const rows = db.prepare("SELECT status, COUNT(*) as count FROM validators GROUP BY status").all();
  const counts = {};
  for (const r of rows) counts[r.status || "unknown"] = r.count;
  return counts;
}

// ---------- Uptime Events ----------
export function insertUptimeEventsBatch(events) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO uptime_events (validator_id, round, seq_num, event_type, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  const insertMany = db.transaction((evts) => {
    for (const e of evts) {
      stmt.run(e.validatorId, e.round, e.seqNum || null, e.eventType, e.timestamp);
    }
  });
  
  return insertMany(events);
}

export function getUptimeStats(validatorId, windowHours = 24) {
  const cutoff = Math.floor(Date.now() / 1000) - (windowHours * 3600);
  
  const stats = db.prepare(`
    SELECT 
      event_type,
      COUNT(*) as count
    FROM uptime_events
    WHERE validator_id = ? AND timestamp >= ?
    GROUP BY event_type
  `).all(validatorId, cutoff);
  
  const result = { finalized: 0, timeout: 0 };
  for (const s of stats) {
    result[s.event_type] = s.count;
  }
  
  const total = result.finalized + result.timeout;
  result.total = total;
  result.uptime_percent = total > 0 ? ((result.finalized / total) * 100).toFixed(2) : "0.00";
  result.window_hours = windowHours;
  result.since_timestamp = cutoff;
  
  return result;
}

export function getRecentEvents(validatorId, limit = 1) {
  return db.prepare(`
    SELECT round, seq_num, event_type, timestamp
    FROM uptime_events
    WHERE validator_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(validatorId, limit);
}

export function cleanupOldEvents(retentionHours = 48) {
  const cutoff = Math.floor(Date.now() / 1000) - (retentionHours * 3600);
  // Only delete events older than cutoff AND that have been snapshotted.
  // We check if there's any epoch snapshot with a timestamp after the event,
  // meaning the event's epoch has been captured.
  const lastSnapshotTs = db.prepare(
    "SELECT MAX(snapshot_ts) as ts FROM uptime_epoch_snapshots"
  ).get()?.ts;

  // If no snapshots exist yet, don't delete anything
  if (!lastSnapshotTs) return 0;

  const result = db.prepare(`
    DELETE FROM uptime_events
    WHERE timestamp < ? AND timestamp < ?
  `).run(cutoff, lastSnapshotTs);
  return result.changes;
}

// ---------- Helpers ----------
export function normalizeAddress(addr) {
  if (!addr) return "";
  let x = addr.toString().trim().toLowerCase();
  if (x.startsWith("0x")) x = x.slice(2);
  return x;
}

export function resolveValidator(idOrAddress) {
  const numId = /^[0-9]+$/.test(idOrAddress) ? parseInt(idOrAddress, 10) : NaN;
  if (!isNaN(numId) && numId > 0) {
    return getValidatorById(numId);
  }
  return getValidatorByAddress(idOrAddress);
}

export function getValidatorIdByAddress(address) {
  const normalized = normalizeAddress(address);
  const row = db.prepare("SELECT id FROM validators WHERE secp_address = ?").get(normalized);
  return row ? row.id : null;
}

// ---------- Secp Address Update ----------
export function updateValidatorSecp(id, secpAddress) {
  return db.prepare("UPDATE validators SET secp_address = ? WHERE id = ?").run(secpAddress, id);
}

// ---------- Status Updates ----------
const updateStatusStmt = db.prepare(`
  UPDATE validators SET status = ?, status_updated_at = strftime('%s', 'now')
  WHERE id = ?
`);

export function updateValidatorStatus(id, status) {
  return updateStatusStmt.run(status, id);
}

export function updateAllValidatorStatuses(statusMap) {
  const txn = db.transaction((map) => {
    for (const [id, status] of Object.entries(map)) {
      updateStatusStmt.run(status, parseInt(id));
    }
  });
  return txn(statusMap);
}

// ---------- Staking Data Updates ----------
const updateStakingStmt = db.prepare(`
  UPDATE validators SET stake_wei = ?, commission_raw = ?, unclaimed_rewards_wei = ?, consensus_stake_wei = ?, snapshot_stake_wei = ?
  WHERE id = ?
`);

export function updateValidatorStakingData(id, stakeWei, commissionRaw, unclaimedRewardsWei, consensusStakeWei, snapshotStakeWei) {
  return updateStakingStmt.run(stakeWei, commissionRaw, unclaimedRewardsWei, consensusStakeWei || null, snapshotStakeWei || null, id);
}

export function updateAllValidatorStakingData(dataMap) {
  const txn = db.transaction((map) => {
    for (const [id, data] of Object.entries(map)) {
      updateStakingStmt.run(data.stake_wei, data.commission_raw, data.unclaimed_rewards_wei, data.consensus_stake_wei || null, data.snapshot_stake_wei || null, parseInt(id));
    }
  });
  return txn(dataMap);
}

export function getStakingPool() {
  const rows = db.prepare("SELECT status, stake_wei, consensus_stake_wei FROM validators WHERE stake_wei IS NOT NULL").all();

  let totalStaked = 0n;
  let bondedTokens = 0n;
  let pendingStake = 0n;
  let pendingUnstake = 0n;
  let activeCount = 0;

  for (const r of rows) {
    const stake = BigInt(r.stake_wei);
    const consensus = r.consensus_stake_wei ? BigInt(r.consensus_stake_wei) : stake;
    totalStaked += stake;
    if (r.status === "active") {
      bondedTokens += stake;
      activeCount++;
    }
    // stake > consensus_stake = new delegations pending activation next epoch
    // consensus_stake > stake = undelegations pending deactivation next epoch
    if (stake > consensus) {
      pendingStake += stake - consensus;
    } else if (consensus > stake) {
      pendingUnstake += consensus - stake;
    }
  }

  return {
    bonded_tokens: bondedTokens.toString(),
    total_staked: totalStaked.toString(),
    pending_stake: pendingStake.toString(),
    pending_unstake: pendingUnstake.toString(),
    total_validators: rows.length,
    active_validators: activeCount,
  };
}

// ---------- Epoch Snapshots ----------
export function saveEpochSnapshotsBatch(snapshots) {
  const stmt = db.prepare(`
    INSERT INTO uptime_epoch_snapshots (validator_id, secp_address, epoch, finalized_count, timeout_count, total_events, uptime_percent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(validator_id, epoch) DO UPDATE SET
      secp_address = excluded.secp_address,
      finalized_count = excluded.finalized_count,
      timeout_count = excluded.timeout_count,
      total_events = excluded.total_events,
      uptime_percent = excluded.uptime_percent,
      snapshot_ts = strftime('%s', 'now')
  `);

  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      const total = r.finalized + r.timeout;
      const pct = total > 0 ? (r.finalized / total) * 100 : 0;
      stmt.run(r.validatorId, r.secpAddress, r.epoch, r.finalized, r.timeout, total, pct);
    }
  });

  return insertMany(snapshots);
}

/**
 * Get uptime event counts grouped by validator since a given timestamp.
 * Used to aggregate events for an epoch window.
 */
export function getUptimeStatsSince(sinceTs) {
  return db.prepare(`
    SELECT
      ue.validator_id,
      v.secp_address,
      ue.event_type,
      COUNT(*) as count
    FROM uptime_events ue
    JOIN validators v ON v.id = ue.validator_id
    WHERE ue.timestamp >= ?
    GROUP BY ue.validator_id, ue.event_type
  `).all(sinceTs);
}

export function getEpochSnapshotExists(epoch) {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM uptime_epoch_snapshots WHERE epoch = ?"
  ).get(epoch);
  return row.count > 0;
}

export function getLastSnapshotEpoch() {
  const row = db.prepare(
    "SELECT MAX(epoch) as last_epoch FROM uptime_epoch_snapshots"
  ).get();
  return row ? row.last_epoch : null;
}

export function getLastSnapshotTimestamp() {
  const row = db.prepare(
    "SELECT MAX(snapshot_ts) as last_ts FROM uptime_epoch_snapshots"
  ).get();
  return row ? row.last_ts : null;
}

/**
 * Get cumulative uptime for a validator over a period.
 * period: "30d" | "90d" | "all"
 */
export function getCumulativeUptime(validatorId, period = "all") {
  let tsFilter = "";
  if (period === "30d") {
    tsFilter = `AND snapshot_ts >= ${Math.floor(Date.now() / 1000) - 30 * 86400}`;
  } else if (period === "90d") {
    tsFilter = `AND snapshot_ts >= ${Math.floor(Date.now() / 1000) - 90 * 86400}`;
  }

  const row = db.prepare(`
    SELECT
      validator_id,
      secp_address,
      SUM(finalized_count) as finalized,
      SUM(timeout_count) as timeout,
      SUM(total_events) as total
    FROM uptime_epoch_snapshots
    WHERE validator_id = ? ${tsFilter}
    GROUP BY validator_id
  `).get(validatorId);

  if (!row || row.total === 0) {
    return { validator_id: validatorId, finalized: 0, timeout: 0, total: 0, uptime_percent: 0 };
  }

  return {
    validator_id: row.validator_id,
    secp_address: row.secp_address,
    finalized: row.finalized,
    timeout: row.timeout,
    total: row.total,
    uptime_percent: parseFloat(((row.finalized / row.total) * 100).toFixed(2)),
  };
}

/**
 * Get cumulative uptime for ALL validators over a period.
 */
export function getAllCumulativeUptime(period = "all") {
  let tsFilter = "";
  if (period === "30d") {
    tsFilter = `WHERE snapshot_ts >= ${Math.floor(Date.now() / 1000) - 30 * 86400}`;
  } else if (period === "90d") {
    tsFilter = `WHERE snapshot_ts >= ${Math.floor(Date.now() / 1000) - 90 * 86400}`;
  }

  const rows = db.prepare(`
    SELECT
      validator_id,
      secp_address,
      SUM(finalized_count) as finalized,
      SUM(timeout_count) as timeout,
      SUM(total_events) as total
    FROM uptime_epoch_snapshots
    ${tsFilter}
    GROUP BY validator_id
    ORDER BY validator_id ASC
  `).all();

  return rows.map((r) => ({
    validator_id: r.validator_id,
    secp_address: r.secp_address,
    finalized: r.finalized,
    timeout: r.timeout,
    total: r.total,
    uptime_percent: r.total > 0 ? parseFloat(((r.finalized / r.total) * 100).toFixed(2)) : 0,
  }));
}

export default db;

export function getLastFinalizedHeight(validatorId) {
  const row = db.prepare(`
    SELECT seq_num
    FROM uptime_events
    WHERE validator_id = ? AND event_type = 'finalized' AND seq_num IS NOT NULL
    ORDER BY round DESC
    LIMIT 1
  `).get(validatorId);
  return row ? row.seq_num : null;
}
