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

  -- Staking precompile event log. ValidatorRewarded is excluded on purpose:
  -- it fires once per block (~286k/day) and is aggregated separately below.
  CREATE TABLE IF NOT EXISTS staking_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_number INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    tx_hash TEXT,
    event_type TEXT NOT NULL,
    validator_id INTEGER,
    address TEXT,
    amount_wei TEXT,
    epoch INTEGER,
    extra TEXT,
    block_ts INTEGER,
    UNIQUE(block_number, log_index)
  );

  CREATE INDEX IF NOT EXISTS idx_staking_events_validator
    ON staking_events(validator_id, block_number DESC);
  CREATE INDEX IF NOT EXISTS idx_staking_events_type
    ON staking_events(event_type, block_number DESC);
  CREATE INDEX IF NOT EXISTS idx_staking_events_address
    ON staking_events(address, block_number DESC);
  CREATE INDEX IF NOT EXISTS idx_staking_events_block
    ON staking_events(block_number DESC);

  -- ValidatorRewarded rolled up per validator per epoch. Storing it raw would
  -- cost ~15 GB/year; this is ~455k rows/year instead.
  CREATE TABLE IF NOT EXISTS validator_rewards_epoch (
    validator_id INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    reward_wei TEXT NOT NULL DEFAULT '0',
    event_count INTEGER NOT NULL DEFAULT 0,
    first_block INTEGER,
    last_block INTEGER,
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (validator_id, epoch)
  );

  CREATE INDEX IF NOT EXISTS idx_rewards_epoch
    ON validator_rewards_epoch(epoch DESC);

  CREATE TABLE IF NOT EXISTS indexer_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
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

// ValidatorRewarded fires for two different things. Once per block, sent by
// the system address, it pays the block's proposer; that one is what makes a
// row count as a proposed block. Anyone can also call externalReward, which
// emits the same event with the caller as `from`. Rows written before these
// columns existed have NULL block_count: the split is unknown until the epoch
// is rebuilt from an archive (backfill-events.js).
for (const col of [
  "block_count INTEGER",
  "block_reward_wei TEXT",
  "max_block_reward REAL",
  "external_count INTEGER NOT NULL DEFAULT 0",
  "external_wei TEXT NOT NULL DEFAULT '0'",
]) {
  try {
    db.exec(`ALTER TABLE validator_rewards_epoch ADD COLUMN ${col}`);
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

/**
 * Uptime stats, last event and last finalized height for every validator at
 * once.
 *
 * The per-validator helpers are fine for a single lookup, but calling them in
 * a loop over the whole set meant three synchronous queries per validator on
 * every request. These three grouped queries replace that entirely.
 */
export function getAllUptimeStats(windowHours = 24) {
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;

  const counts = db.prepare(`
    SELECT validator_id, event_type, COUNT(*) as count
    FROM uptime_events
    WHERE timestamp >= ?
    GROUP BY validator_id, event_type
  `).all(cutoff);

  const lastEvents = db.prepare(`
    SELECT validator_id, round, seq_num, event_type, timestamp
    FROM (
      SELECT validator_id, round, seq_num, event_type, timestamp,
             ROW_NUMBER() OVER (PARTITION BY validator_id ORDER BY timestamp DESC) as rn
      FROM uptime_events
    )
    WHERE rn = 1
  `).all();

  const lastHeights = db.prepare(`
    SELECT validator_id, seq_num
    FROM (
      SELECT validator_id, seq_num,
             ROW_NUMBER() OVER (PARTITION BY validator_id ORDER BY round DESC) as rn
      FROM uptime_events
      WHERE event_type = 'finalized' AND seq_num IS NOT NULL
    )
    WHERE rn = 1
  `).all();

  const stats = new Map();
  for (const c of counts) {
    let entry = stats.get(c.validator_id);
    if (!entry) {
      entry = { finalized: 0, timeout: 0 };
      stats.set(c.validator_id, entry);
    }
    entry[c.event_type] = c.count;
  }

  for (const entry of stats.values()) {
    const total = entry.finalized + entry.timeout;
    entry.total = total;
    entry.uptime_percent = total > 0 ? ((entry.finalized / total) * 100).toFixed(2) : "0.00";
    entry.window_hours = windowHours;
    entry.since_timestamp = cutoff;
  }

  return {
    stats,
    lastEvent: new Map(lastEvents.map((e) => [e.validator_id, e])),
    lastHeight: new Map(lastHeights.map((h) => [h.validator_id, h.seq_num])),
    emptyStats: {
      finalized: 0,
      timeout: 0,
      total: 0,
      uptime_percent: "0.00",
      window_hours: windowHours,
      since_timestamp: cutoff,
    },
  };
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

// Every BOUNDARY_BLOCK_PERIOD blocks is an epoch boundary.
export const BOUNDARY_BLOCK_PERIOD = 50000;

/**
 * Measure the real block time from observed epoch snapshot timestamps.
 *
 * Snapshots are written at epoch transitions, so the gap between two snapshots
 * spans (epochDiff * BOUNDARY_BLOCK_PERIOD) blocks. Averaging over several
 * epochs smooths out the epoch watcher's polling jitter.
 *
 * Returns seconds-per-block, or null when there aren't enough snapshots yet.
 */
export function getMeasuredBlockTime(epochSpan = 12) {
  const rows = db.prepare(`
    SELECT epoch, MIN(snapshot_ts) as ts
    FROM uptime_epoch_snapshots
    GROUP BY epoch
    ORDER BY epoch DESC
    LIMIT ?
  `).all(epochSpan + 1);

  if (rows.length < 2) return null;

  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  const epochsSpanned = newest.epoch - oldest.epoch;
  const secondsSpanned = newest.ts - oldest.ts;

  if (epochsSpanned <= 0 || secondsSpanned <= 0) return null;

  return secondsSpanned / (epochsSpanned * BOUNDARY_BLOCK_PERIOD);
}

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
 * How much snapshot history exists for a validator.
 * Used to say honestly how far back a cumulative figure actually reaches.
 */
export function getEpochCoverage(validatorId) {
  return db.prepare(`
    SELECT
      COUNT(*) as epochs,
      MIN(epoch) as first_epoch,
      MAX(epoch) as last_epoch,
      MIN(snapshot_ts) as first_ts,
      MAX(snapshot_ts) as last_ts
    FROM uptime_epoch_snapshots
    WHERE validator_id = ?
  `).get(validatorId);
}

/**
 * Network-wide uptime per epoch.
 *
 * threshold is the VDP compliance line, so below_threshold is the count of
 * validators that would have been flagged for that epoch.
 */
export function getNetworkUptimeByEpoch(period = "all", threshold = 98) {
  const params = [threshold];
  let tsFilter = "";

  if (period === "30d" || period === "90d") {
    const days = period === "30d" ? 30 : 90;
    tsFilter = "WHERE snapshot_ts >= ?";
    params.push(Math.floor(Date.now() / 1000) - days * 86400);
  }

  return db.prepare(`
    SELECT
      epoch,
      COUNT(*) as validator_count,
      SUM(finalized_count) as finalized,
      SUM(timeout_count) as timeout,
      SUM(total_events) as total,
      SUM(CASE WHEN uptime_percent < ? THEN 1 ELSE 0 END) as below_threshold,
      MIN(snapshot_ts) as snapshot_ts
    FROM uptime_epoch_snapshots
    ${tsFilter}
    GROUP BY epoch
    ORDER BY epoch DESC
  `).all(...params);
}

// VDP evaluates uptime weekly. 1970-01-05 was the first Monday of the Unix
// epoch, so anchoring there puts bucket boundaries on Monday 00:00 UTC.
const WEEK_SECONDS = 604800;
const MONDAY_ANCHOR = 345600;

// Uptime is summed as counts and divided once. Averaging the per-epoch
// percentages instead would weight a quiet epoch the same as a busy one.
const WEEKLY_UPTIME_SELECT = `
  ((snapshot_ts - ${MONDAY_ANCHOR}) / ${WEEK_SECONDS}) as week_index,
  COUNT(DISTINCT epoch) as epochs,
  SUM(finalized_count) as finalized,
  SUM(timeout_count) as timeout,
  SUM(total_events) as total
`;

export function getWeeklyUptime(validatorId) {
  return db.prepare(`
    SELECT ${WEEKLY_UPTIME_SELECT}
    FROM uptime_epoch_snapshots
    WHERE validator_id = ?
    GROUP BY week_index
    ORDER BY week_index DESC
  `).all(validatorId);
}

export function getAllWeeklyUptime() {
  return db.prepare(`
    SELECT validator_id, ${WEEKLY_UPTIME_SELECT}
    FROM uptime_epoch_snapshots
    GROUP BY validator_id, week_index
    ORDER BY validator_id ASC, week_index DESC
  `).all();
}

export const VDP_WEEK_SECONDS = WEEK_SECONDS;
export const VDP_MONDAY_ANCHOR = MONDAY_ANCHOR;

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

// ---------- Staking Event Indexer ----------

export function getIndexerCursor(key) {
  const row = db.prepare("SELECT value FROM indexer_state WHERE key = ?").get(key);
  return row ? row.value : null;
}

const setCursorStmt = db.prepare(`
  INSERT INTO indexer_state (key, value, updated_at)
  VALUES (?, ?, strftime('%s', 'now'))
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = strftime('%s', 'now')
`);

export function setIndexerCursor(key, value) {
  return setCursorStmt.run(key, String(value));
}

const insertEventStmt = db.prepare(`
  INSERT OR IGNORE INTO staking_events
    (block_number, log_index, tx_hash, event_type, validator_id, address, amount_wei, epoch, extra, block_ts)
  VALUES (@blockNumber, @logIndex, @txHash, @eventType, @validatorId, @address, @amountWei, @epoch, @extra, @blockTs)
`);

const getRewardStmt = db.prepare(`
  SELECT reward_wei, event_count, block_count, block_reward_wei, max_block_reward,
         external_count, external_wei, first_block, last_block
  FROM validator_rewards_epoch
  WHERE validator_id = ? AND epoch = ?
`);

const writeRewardStmt = db.prepare(`
  INSERT OR REPLACE INTO validator_rewards_epoch
    (validator_id, epoch, reward_wei, event_count, block_count, block_reward_wei,
     max_block_reward, external_count, external_wei, first_block, last_block, updated_at)
  VALUES (@validatorId, @epoch, @rewardWei, @eventCount, @blockCount, @blockRewardWei,
          @maxBlockReward, @externalCount, @externalWei, @firstBlock, @lastBlock,
          strftime('%s', 'now'))
`);

function rewardRow(r) {
  return {
    validatorId: r.validatorId,
    epoch: r.epoch,
    rewardWei: r.amountWei.toString(),
    eventCount: r.count,
    blockCount: r.blockCount,
    blockRewardWei: r.blockWei === null ? null : r.blockWei.toString(),
    maxBlockReward: r.maxBlockReward,
    externalCount: r.externalCount,
    externalWei: r.externalWei.toString(),
    firstBlock: r.firstBlock,
    lastBlock: r.lastBlock,
  };
}

/** Add a batch's rewards to what the row already holds. */
function mergeReward(existing, r) {
  if (!existing) return r;
  // A row from before the split columns existed cannot be split after the
  // fact; it stays unknown until the epoch is rebuilt from an archive.
  const legacy = existing.block_count === null;
  return {
    ...r,
    amountWei: BigInt(existing.reward_wei) + r.amountWei,
    count: existing.event_count + r.count,
    blockCount: legacy ? null : existing.block_count + r.blockCount,
    blockWei: legacy ? null : BigInt(existing.block_reward_wei) + r.blockWei,
    maxBlockReward: legacy ? null : Math.max(existing.max_block_reward ?? 0, r.maxBlockReward ?? 0),
    externalCount: existing.external_count + r.externalCount,
    externalWei: BigInt(existing.external_wei) + r.externalWei,
    // Ranges can arrive out of order, so the bounds widen rather than move.
    firstBlock: Math.min(existing.first_block ?? r.firstBlock, r.firstBlock),
    lastBlock: Math.max(existing.last_block ?? r.lastBlock, r.lastBlock),
  };
}

/**
 * Commit one indexed block range atomically.
 *
 * Rewards accumulate by read-modify-write, so replaying a range would double
 * count. Advancing the cursor in the same transaction as the writes is what
 * prevents that: a crash rolls back the data and the cursor together, and the
 * range is retried from a clean state.
 */
export const commitIndexedRange = db.transaction((events, rewards, cursorKey, cursorValue) => {
  for (const e of events) {
    insertEventStmt.run(e);
  }

  for (const r of rewards) {
    const existing = getRewardStmt.get(r.validatorId, r.epoch);
    writeRewardStmt.run(rewardRow(mergeReward(existing, r)));
  }

  setCursorStmt.run(cursorKey, String(cursorValue));
});

/**
 * Replace everything stored for one completed epoch with a fresh read of it.
 * Used by the archive backfill: because the epoch is replaced whole rather
 * than added to, running it twice gives the same result as running it once.
 * Events are keyed by (block, log index), so re-inserting them is a no-op.
 */
export const replaceEpochRewards = db.transaction((epoch, events, rewards, cursorKey) => {
  db.prepare("DELETE FROM validator_rewards_epoch WHERE epoch = ?").run(epoch);
  for (const e of events) insertEventStmt.run(e);
  for (const r of rewards) writeRewardStmt.run(rewardRow(r));
  setCursorStmt.run(cursorKey, String(epoch));
});

/**
 * The block reward for each epoch, as observed. A ValidatorRewarded from the
 * system address carries the delegators' share, reward x (1 - commission), so
 * the largest one in an epoch is the full reward, paid to a validator at 0%
 * commission. Every epoch sampled on mainnet has hundreds of those. This is
 * how the reward schedule (0, then 25, then 18 MON on mainnet) comes out of
 * the data rather than a constant.
 */
export function getEpochBlockRewards(epochs) {
  if (!epochs.length) return new Map();
  const rows = db.prepare(`
    SELECT epoch, MAX(max_block_reward) AS reward
    FROM validator_rewards_epoch
    WHERE epoch IN (${epochs.map(() => "?").join(",")}) AND block_count > 0
    GROUP BY epoch
  `).all(...epochs);
  return new Map(rows.map((r) => [r.epoch, r.reward]));
}

/** Blocks proposed per validator across every epoch whose split is known. */
export function getBlocksProposedTotals(sinceEpoch = null) {
  const where = ["block_count IS NOT NULL"];
  const params = [];
  if (sinceEpoch != null) {
    where.push("epoch >= ?");
    params.push(sinceEpoch);
  }
  return db.prepare(`
    SELECT validator_id, SUM(block_count) AS blocks, MIN(epoch) AS first_epoch,
           MAX(epoch) AS last_epoch, COUNT(*) AS epochs_with_blocks
    FROM validator_rewards_epoch
    WHERE ${where.join(" AND ")} AND block_count > 0
    GROUP BY validator_id
    ORDER BY blocks DESC
  `).all(...params);
}

export function getStakingEvents({ validatorId, address, eventType, limit = 50 } = {}) {
  const where = [];
  const params = [];

  if (validatorId != null) {
    where.push("validator_id = ?");
    params.push(validatorId);
  }
  if (address) {
    where.push("address = ?");
    params.push(address.toLowerCase());
  }
  if (eventType) {
    where.push("event_type = ?");
    params.push(eventType);
  }

  params.push(Math.min(Math.max(limit, 1), 500));

  return db.prepare(`
    SELECT block_number, log_index, tx_hash, event_type, validator_id,
           address, amount_wei, epoch, extra, block_ts
    FROM staking_events
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY block_number DESC, log_index DESC
    LIMIT ?
  `).all(...params);
}

export function getValidatorEpochRewards(validatorId, limit = 100) {
  return db.prepare(`
    SELECT epoch, reward_wei, event_count, block_count, block_reward_wei,
           external_count, external_wei, first_block, last_block
    FROM validator_rewards_epoch
    WHERE validator_id = ?
    ORDER BY epoch DESC
    LIMIT ?
  `).all(validatorId, Math.min(Math.max(limit, 1), 500));
}

/**
 * Delegate and Undelegate rows for stake-flow aggregation.
 *
 * Only these two move stake. Withdraw is the delegator collecting funds that
 * Undelegate already removed from the pool, and ClaimRewards is rewards, so
 * counting either as outflow would double count. Amounts come back as wei
 * strings and are summed with BigInt by the caller, since the totals exceed
 * what a double holds exactly.
 */
export function getStakeFlowRows(validatorId, sinceTs) {
  const where = ["event_type IN ('Delegate', 'Undelegate')"];
  const params = [];
  if (validatorId != null) {
    where.push("validator_id = ?");
    params.push(validatorId);
  }
  if (sinceTs != null) {
    where.push("block_ts >= ?");
    params.push(sinceTs);
  }
  return db.prepare(`
    SELECT validator_id, event_type, address, amount_wei
    FROM staking_events
    WHERE ${where.join(" AND ")}
  `).all(...params);
}

/** Oldest and newest raw round in the rolling window. */
export function getUptimeEventBounds() {
  return db.prepare(
    "SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest, COUNT(*) as count FROM uptime_events"
  ).get();
}

// ---------- Indexer health ----------
//
// The cursor alone cannot tell a healthy indexer from a stuck one: both leave
// a number in indexer_state. These keys record the last successful run, the
// last error, and any block ranges that were skipped, so /monad-api/status can
// say "stalled" instead of leaving the operator to compare two snapshots.

const HEALTH_KEYS = {
  lastSuccess: "staking_events_last_success",
  lastError: "staking_events_last_error",
  gaps: "staking_events_gaps",
};

const MAX_RECORDED_GAPS = 20;

export function markIndexerSuccess() {
  setCursorStmt.run(HEALTH_KEYS.lastSuccess, String(Math.floor(Date.now() / 1000)));
}

export function markIndexerError(message) {
  setCursorStmt.run(
    HEALTH_KEYS.lastError,
    JSON.stringify({ message: String(message).slice(0, 500), ts: Math.floor(Date.now() / 1000) })
  );
}

/** Remember a block range the indexer gave up on, newest last. */
export function recordIndexerGap(fromBlock, toBlock) {
  const gaps = getIndexerGaps();
  gaps.push({ from_block: fromBlock, to_block: toBlock, ts: Math.floor(Date.now() / 1000) });
  setCursorStmt.run(HEALTH_KEYS.gaps, JSON.stringify(gaps.slice(-MAX_RECORDED_GAPS)));
}

/** Drop a recorded gap once a backfill has filled it. */
export function clearIndexerGap(fromBlock, toBlock) {
  const gaps = getIndexerGaps().filter(
    (g) => !(g.from_block === fromBlock && g.to_block === toBlock)
  );
  setCursorStmt.run(HEALTH_KEYS.gaps, JSON.stringify(gaps));
}

/**
 * Blocks with a recorded proposer, per epoch. Every block pays exactly one
 * block reward, so a fully indexed epoch sums to its length in blocks. NULL
 * blocks means some row in the epoch predates the block/external split.
 */
export function getBlocksPerEpoch() {
  return db.prepare(`
    SELECT epoch,
           CASE WHEN SUM(block_count IS NULL) > 0 THEN NULL ELSE SUM(block_count) END AS blocks,
           MIN(first_block) AS first_block, MAX(last_block) AS last_block
    FROM validator_rewards_epoch
    GROUP BY epoch
    ORDER BY epoch
  `).all();
}

export function getIndexerGaps() {
  const raw = getIndexerCursor(HEALTH_KEYS.gaps);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getIndexerHealth() {
  const success = getIndexerCursor(HEALTH_KEYS.lastSuccess);
  const errorRaw = getIndexerCursor(HEALTH_KEYS.lastError);
  let lastError = null;
  if (errorRaw) {
    try {
      lastError = JSON.parse(errorRaw);
    } catch {
      lastError = { message: errorRaw, ts: null };
    }
  }
  return {
    last_success_ts: success ? Number(success) : null,
    last_error: lastError,
    gaps: getIndexerGaps(),
  };
}

export function getIndexerStats() {
  const events = db.prepare("SELECT COUNT(*) as c FROM staking_events").get().c;
  const rewardRows = db.prepare("SELECT COUNT(*) as c FROM validator_rewards_epoch").get().c;
  const range = db.prepare(
    "SELECT MIN(block_number) as first, MAX(block_number) as last FROM staking_events"
  ).get();
  return {
    events,
    reward_rows: rewardRows,
    first_event_block: range?.first ?? null,
    last_event_block: range?.last ?? null,
    // Ranges the indexer skipped. Anything derived from events (flow, rewards,
    // the event lists) is silently short over these blocks, so every response
    // that carries indexer stats carries the gaps with them.
    gaps: getIndexerGaps().map((g) => ({
      from_block: g.from_block,
      to_block: g.to_block,
      skipped_at_utc: g.ts ? new Date(g.ts * 1000).toISOString() : null,
    })),
  };
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
