// src/metrics.js - Prometheus exposition for the validator dataset
//
// Every series here is read from SQLite. Nothing in this file touches the RPC:
// a scrape runs every 15-30 seconds and must never be able to stall behind the
// node or count against the staking rate limit.

import {
  getAllValidators,
  getAllUptimeStats,
  getValidatorCountsByStatus,
  getAllWeeklyUptime,
  getIndexerStats,
  getIndexerCursor,
  getMeasuredBlockTime,
  getLastSnapshotEpoch,
} from "./db.js";
import { VDP_RULES, evaluateWeeks, evaluateCompliance, commissionOf } from "./vdp.js";

// Label values are free text — validator names come from a GitHub repo — so
// they need escaping before they can go inside quotes.
function esc(v) {
  return String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function labels(obj) {
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

class Registry {
  constructor() {
    this.lines = [];
  }

  metric(name, help, type, samples) {
    if (!samples.length) return;
    this.lines.push(`# HELP ${name} ${help}`);
    this.lines.push(`# TYPE ${name} ${type}`);
    for (const [lbl, value] of samples) {
      if (value === null || value === undefined || Number.isNaN(value)) continue;
      this.lines.push(`${name}${lbl} ${value}`);
    }
  }

  toString() {
    return this.lines.join("\n") + "\n";
  }
}

const VDP_STATES = ["compliant", "at_risk", "breach", "insufficient_data"];

// The Validator Delegation Program is a mainnet arrangement. Read at call
// time: a module-scope read runs before index.js gets to dotenv.config(),
// because ES module imports are hoisted above the body.
function isMainnet() {
  return (process.env.NETWORK || "").toLowerCase() === "mainnet";
}

export function renderMetrics() {
  const r = new Registry();
  const validators = getAllValidators();

  r.metric("monad_api_up", "Always 1 when the API is answering.", "gauge", [["", 1]]);

  // Mainnet and testnet are separate deployments whose validator IDs both start
  // at 1, so a scrape needs to say which chain it came from without the reader
  // having to consult the scrape config.
  r.metric(
    "monad_build_info",
    "Deployment metadata. Always 1; read the labels.",
    "gauge",
    [[labels({ network: process.env.NETWORK || "unknown" }), 1]]
  );

  // ---------- validator inventory ----------
  const counts = getValidatorCountsByStatus();
  r.metric(
    "monad_validators",
    "Validators known to the API, by status.",
    "gauge",
    ["active", "pending", "inactive", "unknown"].map((s) => [
      labels({ status: s }),
      counts[s] || 0,
    ])
  );

  // ---------- uptime over the rolling window ----------
  const bulk = getAllUptimeStats(24);
  const uptime = [];
  const finalized = [];
  const timeouts = [];
  let netFinalized = 0;
  let netTotal = 0;

  for (const v of validators) {
    const s = bulk.stats.get(v.id);
    if (!s) continue;
    const l = labels({ id: v.id, name: v.name, status: v.status || "unknown" });
    uptime.push([l, parseFloat(s.uptime_percent)]);
    finalized.push([l, s.finalized]);
    timeouts.push([l, s.timeout]);
    netFinalized += s.finalized;
    netTotal += s.total;
  }

  r.metric("monad_validator_uptime_percent", "Uptime over the last 24 hours.", "gauge", uptime);
  r.metric("monad_validator_finalized_rounds", "Rounds finalized in the last 24 hours.", "gauge", finalized);
  r.metric("monad_validator_timeout_rounds", "Rounds missed in the last 24 hours.", "gauge", timeouts);
  r.metric(
    "monad_network_uptime_percent",
    "Network-wide uptime over the last 24 hours.",
    "gauge",
    [["", netTotal > 0 ? parseFloat(((netFinalized / netTotal) * 100).toFixed(2)) : 0]]
  );

  // ---------- stake and commission ----------
  const stake = [];
  const commission = [];
  for (const v of validators) {
    const l = labels({ id: v.id, name: v.name });
    if (v.stake_wei) {
      stake.push([l, parseFloat((Number(BigInt(v.stake_wei) / 10n ** 14n) / 1e4).toFixed(4))]);
    }
    const c = commissionOf(v);
    if (c !== null) commission.push([l, c]);
  }
  r.metric("monad_validator_stake_mon", "Validator stake in MON.", "gauge", stake);
  r.metric("monad_validator_commission_percent", "Validator commission.", "gauge", commission);

  // ---------- VDP compliance ----------
  // The delegation program is a mainnet arrangement. The weekly uptime maths
  // runs anywhere, but a testnet "breach" means nothing, so these series are
  // withheld rather than left to raise alerts nobody should act on.
  if (isMainnet()) {
    const weeksByValidator = new Map();
    for (const row of getAllWeeklyUptime()) {
      if (!weeksByValidator.has(row.validator_id)) weeksByValidator.set(row.validator_id, []);
      weeksByValidator.get(row.validator_id).push(row);
    }

    const strikes = [];
    const compliant = [];
    const stateCounts = Object.fromEntries(VDP_STATES.map((s) => [s, 0]));

    for (const v of validators) {
      const weeks = evaluateWeeks(weeksByValidator.get(v.id) || []);
      const verdict = evaluateCompliance(weeks, commissionOf(v));
      const l = labels({ id: v.id, name: v.name });

      strikes.push([l, verdict.uptime.strikes]);
      // Only a verdict backed by enough history claims compliance; anything else
      // is 0 so an alert cannot be silenced by a validator we barely know.
      compliant.push([l, verdict.status === "compliant" ? 1 : 0]);
      stateCounts[verdict.status] = (stateCounts[verdict.status] || 0) + 1;
    }

    r.metric(
      "monad_validator_vdp_strikes",
      `Weeks below ${VDP_RULES.uptime_threshold}% inside the ${VDP_RULES.strike_window_days} day window.`,
      "gauge",
      strikes
    );
    r.metric(
      "monad_validator_vdp_compliant",
      "1 when the validator is compliant on a full window, 0 otherwise.",
      "gauge",
      compliant
    );
    r.metric(
      "monad_validators_vdp",
      "Validators by VDP status.",
      "gauge",
      VDP_STATES.map((s) => [labels({ state: s }), stateCounts[s] || 0])
    );
    r.metric(
      "monad_vdp_max_strikes",
      "Strikes that warrant removal from the program.",
      "gauge",
      [["", VDP_RULES.max_strikes]]
    );
  }

  // ---------- indexer and chain ----------
  const idx = getIndexerStats();
  r.metric("monad_staking_events_indexed", "Staking events stored.", "gauge", [["", idx.events]]);
  r.metric("monad_reward_epoch_rows", "Rows in the per-epoch reward rollup.", "gauge", [["", idx.reward_rows]]);

  const cursor = getIndexerCursor("staking_events_last_block");
  if (cursor !== null) {
    r.metric("monad_indexer_block", "Last block the event indexer committed.", "gauge", [["", Number(cursor)]]);
  }

  const lastEpoch = getLastSnapshotEpoch();
  if (lastEpoch !== null) {
    r.metric("monad_last_snapshot_epoch", "Most recent epoch with uptime snapshots.", "gauge", [["", lastEpoch]]);
  }

  const blockTime = getMeasuredBlockTime();
  if (blockTime !== null) {
    r.metric(
      "monad_measured_block_time_seconds",
      "Block time measured across recent epoch snapshots.",
      "gauge",
      [["", parseFloat(blockTime.toFixed(5))]]
    );
  }

  return r.toString();
}
