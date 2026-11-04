// src/routes/validators.js - API Routes
import { Router } from "express";
import { ethers } from "ethers";
import {
  resolveValidator,
  getAllValidators,
  getUptimeStats,
  getRecentEvents,
  getValidatorCount, getLastFinalizedHeight,
  getCumulativeUptime,
  getAllCumulativeUptime,
  getEpochCoverage,
  getNetworkUptimeByEpoch,
  getValidatorCountsByStatus,
  getWeeklyUptime,
  getAllWeeklyUptime,
  getAllUptimeStats
} from "./db.js";
import {
  VDP_RULES,
  vdpNote,
  vdpApplies,
  evaluateWeeks,
  evaluateCompliance,
  commissionOf
} from "./vdp.js";
import { lightLimit, heavyLimit, memo, parseLimit, internalError } from "./guards.js";

const router = Router();

// Abuse ceilings only, far above what real clients send: every route here
// allows 300 requests per second per IP, and the routes that aggregate over
// the whole validator set allow 50.
router.use(lightLimit);

// How long the all-validator aggregates are reused. They are rebuilt from
// SQLite, which the logger and the syncs keep writing, so a short reuse
// window keeps them current while a burst of callers shares one computation.
const UPTIME_CACHE_MS = 20_000;
const AGGREGATE_CACHE_MS = 30_000;

const CUMULATIVE_PERIODS = ["30d", "90d", "all"];

// VDP requires uptime above 98%.
const UPTIME_THRESHOLD = 98;

// A validator finalizing rounds emits events constantly, so a gap this long
// means it stopped being seen rather than that it merely had a quiet spell.
const STALE_AFTER_SECONDS = 900;

// ---------- Helpers ----------
function toISO(epoch) {
  return epoch ? new Date(epoch * 1000).toISOString() : null;
}

function toMON(wei) {
  return parseFloat(parseFloat(ethers.formatEther(BigInt(wei))).toFixed(2));
}

function formatValidator(v) {
  if (!v) return null;

  let extra = {};
  try {
    extra = JSON.parse(v.raw_json || "{}");
  } catch {}

  return {
    id: v.id,
    secp_address: v.secp_address,
    bls_public_key: v.bls_public_key,
    name: v.name,
    website: v.website,
    description: v.description,
    logo_url: v.logo_url,
    ...(extra.x && { x: extra.x }),
    ...(extra.twitter && { twitter: extra.twitter }),
    ...(extra.discord && { discord: extra.discord }),
    ...(extra.telegram && { telegram: extra.telegram }),
    status: v.status || "unknown",
    stake: v.stake_wei ? toMON(v.stake_wei) : null,
    // Active this epoch vs active next epoch — synced but never surfaced before.
    consensus_stake: v.consensus_stake_wei ? toMON(v.consensus_stake_wei) : null,
    snapshot_stake: v.snapshot_stake_wei ? toMON(v.snapshot_stake_wei) : null,
    commission: v.commission_raw ? parseFloat((Number(v.commission_raw) / 1e18 * 100).toFixed(2)) : null,
    unclaimed_rewards: v.unclaimed_rewards_wei ? toMON(v.unclaimed_rewards_wei) : null,
    updated_at: toISO(Math.max(v.updated_at || 0, v.status_updated_at || 0) || null)
  };
}

// lastHeight is passed in rather than looked up here, so the list route can
// resolve it for every validator in one query instead of one query each.
function formatUptime(stats, validator, lastEvent = null, lastHeight = undefined) {
  return {
    validator_id: validator.id,
    validator_name: validator.name,
    secp_address: validator.secp_address,
    status: validator.status || "unknown",
    window_hours: stats.window_hours,
    finalized_count: stats.finalized,
    timeout_count: stats.timeout,
    total_events: stats.total,
    uptime_percent: parseFloat(stats.uptime_percent),
    last_round: lastEvent?.round || null,
    last_block_height:
      lastHeight === undefined ? getLastFinalizedHeight(validator.id) : lastHeight,
    since_timestamp: stats.since_timestamp,
    since_utc: new Date(stats.since_timestamp * 1000).toISOString()
  };
}

// ---------- Routes ----------

// GET /monad-api/validators
router.get("/", (req, res) => {
  try {
    const all = getAllValidators();
    const total = all.length;

    // Optional: the full set is small enough to return whole, so paging stays
    // opt-in rather than a breaking change to the default response.
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const validators = req.query.limit
      ? all.slice(offset, offset + parseLimit(req.query.limit, 50, 500))
      : all.slice(offset);

    res.json({
      success: true,
      count: validators.length,
      total,
      validators: validators.map(formatValidator)
    });
  } catch (err) {
    internalError(req, res, err);
  }
});

// GET /monad-api/validators/stats
router.get("/stats", (req, res) => {
  try {
    const count = getValidatorCount();
    const byStatus = getValidatorCountsByStatus();
    res.json({
      success: true,
      total_validators: count,
      by_status: {
        active: byStatus.active || 0,
        pending: byStatus.pending || 0,
        inactive: byStatus.inactive || 0,
        unknown: byStatus.unknown || 0
      },
      api_version: "1.0.0"
    });
  } catch (err) {
    internalError(req, res, err);
  }
});

// GET /monad-api/validators/uptime/:idOrAddress
// ?period=30d|90d|all  -> cumulative, from permanent epoch snapshots
// ?window=1-168        -> rolling window over raw events (default)
router.get("/uptime/:idOrAddress", (req, res) => {
  try {
    const { idOrAddress } = req.params;
    const period = req.query.period;
    const windowHours = Math.min(Math.max(Number(req.query.window) || 24, 1), 168);

    const validator = resolveValidator(idOrAddress);
    if (!validator) {
      return res.status(404).json({
        success: false,
        error: "Validator not found",
        hint: "Use validator ID (e.g., 1) or Secp address (0x...)"
      });
    }

    if (period) {
      if (!CUMULATIVE_PERIODS.includes(period)) {
        return res.status(400).json({
          success: false,
          error: "Invalid period",
          hint: `Use one of: ${CUMULATIVE_PERIODS.join(", ")}`
        });
      }
      const cumulative = getCumulativeUptime(validator.id, period);
      return res.json({
        success: true,
        period,
        uptime: {
          validator_id: validator.id,
          validator_name: validator.name,
          secp_address: validator.secp_address,
          status: validator.status || "unknown",
          finalized_count: cumulative.finalized,
          timeout_count: cumulative.timeout,
          total_events: cumulative.total,
          uptime_percent: cumulative.uptime_percent
        }
      });
    }

    const stats = getUptimeStats(validator.id, windowHours);
    const recentEvents = getRecentEvents(validator.id, 1);
    const lastEvent = recentEvents.length > 0 ? recentEvents[0] : null;
    
    res.json({
      success: true,
      uptime: formatUptime(stats, validator, lastEvent)
    });
  } catch (err) {
    internalError(req, res, err);
  }
});

// GET /monad-api/validators/uptime/:idOrAddress/history
router.get("/uptime/:idOrAddress/history", (req, res) => {
  try {
    const { idOrAddress } = req.params;
    const limit = parseLimit(req.query.limit, 49, 100);
    
    const validator = resolveValidator(idOrAddress);
    if (!validator) {
      return res.status(404).json({
        success: false,
        error: "Validator not found",
        hint: "Use validator ID (e.g., 1) or Secp address (0x...)"
      });
    }
    
    const events = getRecentEvents(validator.id, limit);
    
    res.json({
      success: true,
      validator_id: validator.id,
      validator_name: validator.name,
      count: events.length,
      history: events.map(e => ({
        round: e.round,
        height: e.seq_num,
        status: e.event_type
      }))
    });
  } catch (err) {
    internalError(req, res, err);
  }
});

// Every validator's cumulative uptime over a snapshot period, unsorted.
function cumulativeUptimeRows(period) {
  const byId = new Map(getAllValidators().map((v) => [v.id, v]));
  return getAllCumulativeUptime(period).map((r) => {
    const v = byId.get(r.validator_id);
    return {
      validator_id: r.validator_id,
      validator_name: v?.name || `Validator #${r.validator_id}`,
      secp_address: r.secp_address,
      status: v?.status || "unknown",
      finalized_count: r.finalized,
      timeout_count: r.timeout,
      total_events: r.total,
      uptime_percent: r.uptime_percent
    };
  });
}

// Every validator's uptime over a rolling window, in validator ID order.
function windowUptimeRows(windowHours) {
  const bulk = getAllUptimeStats(windowHours);
  return getAllValidators().map(v =>
    formatUptime(
      bulk.stats.get(v.id) || bulk.emptyStats,
      v,
      bulk.lastEvent.get(v.id) || null,
      bulk.lastHeight.get(v.id) ?? null
    )
  );
}

// GET /monad-api/validators/uptime
// ?period=30d|90d|all  -> cumulative, from permanent epoch snapshots
// ?window=1-168        -> rolling window over raw events (default)
//
// Both forms aggregate over every validator, so the unsorted rows are cached
// for a few seconds and shared; sorting and the limit are applied per request
// to a copy.
router.get("/uptime", heavyLimit, (req, res) => {
  try {
    const period = req.query.period;
    const windowHours = Math.min(Math.max(Number(req.query.window) || 24, 1), 168);
    const sortBy = req.query.sort || "uptime";

    if (period) {
      if (!CUMULATIVE_PERIODS.includes(period)) {
        return res.status(400).json({
          success: false,
          error: "Invalid period",
          hint: `Use one of: ${CUMULATIVE_PERIODS.join(", ")}`
        });
      }

      let rows = memo(`uptime:period:${period}`, UPTIME_CACHE_MS, () =>
        cumulativeUptimeRows(period)
      ).slice();

      if (sortBy === "id") {
        rows.sort((a, b) => a.validator_id - b.validator_id);
      } else {
        rows.sort((a, b) => b.uptime_percent - a.uptime_percent);
      }

      // Sorted by uptime and capped, this is the leaderboard.
      const total = rows.length;
      if (req.query.limit) {
        rows = rows.slice(0, parseLimit(req.query.limit, 50, 500));
      }

      return res.json({
        success: true,
        period,
        count: rows.length,
        total,
        validators: rows
      });
    }

    // Whole-hour windows are what clients ask for and are cached. Any other
    // window is computed on its own, so odd values cannot crowd the cache.
    let results = (
      Number.isInteger(windowHours)
        ? memo(`uptime:window:${windowHours}`, UPTIME_CACHE_MS, () => windowUptimeRows(windowHours))
        : windowUptimeRows(windowHours)
    ).slice();

    if (sortBy === "uptime") {
      results.sort((a, b) => b.uptime_percent - a.uptime_percent);
    } else if (sortBy === "id") {
      results.sort((a, b) => a.validator_id - b.validator_id);
    }

    const total = results.length;
    if (req.query.limit) {
      results = results.slice(0, parseLimit(req.query.limit, 50, 500));
    }

    res.json({
      success: true,
      window_hours: windowHours,
      count: results.length,
      total,
      validators: results
    });
  } catch (err) {
    internalError(req, res, err);
  }
});

// GET /monad-api/validators/network/uptime
// Network-wide uptime per epoch, plus how many validators fell below the
// VDP threshold in each one.
router.get("/network/uptime", heavyLimit, (req, res) => {
  try {
    const period = req.query.period || "all";
    if (!CUMULATIVE_PERIODS.includes(period)) {
      return res.status(400).json({
        success: false,
        error: "Invalid period",
        hint: `Use one of: ${CUMULATIVE_PERIODS.join(", ")}`
      });
    }

    res.json(memo(`network-uptime:${period}`, AGGREGATE_CACHE_MS, () => networkUptimeBody(period)));
  } catch (err) {
    internalError(req, res, err);
  }
});

function networkUptimeBody(period) {
  const epochs = getNetworkUptimeByEpoch(period, UPTIME_THRESHOLD);

  let finalized = 0;
  let timeout = 0;
  for (const e of epochs) {
    finalized += e.finalized;
    timeout += e.timeout;
  }
  const total = finalized + timeout;

  return {
    success: true,
    period,
    threshold: UPTIME_THRESHOLD,
    summary: {
      epochs: epochs.length,
      finalized_count: finalized,
      timeout_count: timeout,
      total_events: total,
      uptime_percent: total > 0 ? parseFloat(((finalized / total) * 100).toFixed(2)) : 0
    },
    epochs: epochs.map(e => ({
      epoch: e.epoch,
      validator_count: e.validator_count,
      finalized_count: e.finalized,
      timeout_count: e.timeout,
      total_events: e.total,
      uptime_percent: e.total > 0
        ? parseFloat(((e.finalized / e.total) * 100).toFixed(2))
        : 0,
      below_threshold: e.below_threshold,
      snapshot_ts: e.snapshot_ts,
      snapshot_utc: toISO(e.snapshot_ts)
    }))
  };
}

// GET /monad-api/validators/vdp
// Compliance status for every validator, worst first.
router.get("/vdp", heavyLimit, (req, res) => {
  try {
    res.json(memo("vdp", AGGREGATE_CACHE_MS, vdpBody));
  } catch (err) {
    internalError(req, res, err);
  }
});

function vdpBody() {
  const byValidator = new Map();
  for (const row of getAllWeeklyUptime()) {
    if (!byValidator.has(row.validator_id)) byValidator.set(row.validator_id, []);
    byValidator.get(row.validator_id).push(row);
  }

  const validators = getAllValidators();
  const results = [];

  for (const v of validators) {
    // A validator with no snapshots at all is the most insufficient case
    // there is, so it belongs in the list rather than dropped from it.
    const weeks = evaluateWeeks(byValidator.get(v.id) || []);
    const verdict = evaluateCompliance(weeks, commissionOf(v));

    results.push({
      validator_id: v.id,
      validator_name: v.name,
      status: v.status || "unknown",
      vdp_status: verdict.status,
      strikes: verdict.uptime.strikes,
      strikes_remaining: verdict.uptime.strikes_remaining,
      commission: verdict.commission.current,
      commission_compliant: verdict.commission.compliant,
      weeks_in_window: verdict.coverage.weeks_in_window,
      sufficient_data: verdict.coverage.sufficient,
      // What we have seen across all recorded history, not just the window.
      observed_weeks: verdict.observed.complete_weeks,
      observed_weeks_below_threshold: verdict.observed.weeks_below_threshold,
      observed_uptime_percent: verdict.observed.uptime_percent,
      observed_since_utc: verdict.observed.since_utc
    });
  }

  // Surface problems first: breaches, then at risk, then by strike count.
  const rank = { breach: 0, at_risk: 1, insufficient_data: 2, compliant: 3 };
  results.sort(
    (a, b) => rank[a.vdp_status] - rank[b.vdp_status] || b.strikes - a.strikes
  );

  const summary = { breach: 0, at_risk: 0, insufficient_data: 0, compliant: 0 };
  for (const r of results) summary[r.vdp_status]++;

  return {
    success: true,
    rules: VDP_RULES,
    applies: vdpApplies(),
    note: vdpNote(),
    summary,
    count: results.length,
    validators: results
  };
}

// GET /monad-api/validators/:idOrAddress/vdp
router.get("/:idOrAddress/vdp", (req, res) => {
  try {
    const { idOrAddress } = req.params;
    const validator = resolveValidator(idOrAddress);
    if (!validator) {
      return res.status(404).json({
        success: false,
        error: "Validator not found",
        hint: "Use validator ID (e.g., 1) or Secp address (0x...)"
      });
    }

    const weeks = evaluateWeeks(getWeeklyUptime(validator.id));
    const verdict = evaluateCompliance(weeks, commissionOf(validator));

    res.json({
      success: true,
      rules: VDP_RULES,
      applies: vdpApplies(),
      note: vdpNote(),
      vdp: {
        validator_id: validator.id,
        validator_name: validator.name,
        status: validator.status || "unknown",
        ...verdict,
        weeks
      }
    });
  } catch (err) {
    internalError(req, res, err);
  }
});

// GET /monad-api/validators/:idOrAddress/health
// Compact status for monitoring and alerting.
router.get("/:idOrAddress/health", (req, res) => {
  try {
    const { idOrAddress } = req.params;
    const validator = resolveValidator(idOrAddress);
    if (!validator) {
      return res.status(404).json({
        success: false,
        error: "Validator not found",
        hint: "Use validator ID (e.g., 1) or Secp address (0x...)"
      });
    }

    const recent = getRecentEvents(validator.id, 1);
    const lastEvent = recent.length > 0 ? recent[0] : null;
    const now = Math.floor(Date.now() / 1000);
    const secondsSinceLastEvent = lastEvent ? now - lastEvent.timestamp : null;

    const stats = getUptimeStats(validator.id, 24);
    const uptime24h = parseFloat(stats.uptime_percent);
    const coverage = getEpochCoverage(validator.id);

    // no_data and stale are different failures: one means we never saw this
    // validator, the other means we stopped seeing it.
    let state;
    if (!lastEvent) {
      state = "no_data";
    } else if (secondsSinceLastEvent > STALE_AFTER_SECONDS) {
      state = "stale";
    } else if (uptime24h < UPTIME_THRESHOLD) {
      state = "degraded";
    } else {
      state = "healthy";
    }

    res.json({
      success: true,
      health: {
        validator_id: validator.id,
        validator_name: validator.name,
        status: validator.status || "unknown",
        state,
        healthy: state === "healthy",
        threshold: UPTIME_THRESHOLD,
        uptime_24h: uptime24h,
        last_round: lastEvent?.round || null,
        last_block_height: getLastFinalizedHeight(validator.id),
        last_event_ts: lastEvent?.timestamp || null,
        last_event_utc: lastEvent ? toISO(lastEvent.timestamp) : null,
        seconds_since_last_event: secondsSinceLastEvent,
        snapshot_coverage: {
          epochs: coverage?.epochs || 0,
          first_epoch: coverage?.first_epoch ?? null,
          last_epoch: coverage?.last_epoch ?? null,
          since_utc: coverage?.first_ts ? toISO(coverage.first_ts) : null
        }
      }
    });
  } catch (err) {
    internalError(req, res, err);
  }
});

// GET /monad-api/validators/:idOrAddress
router.get("/:idOrAddress", (req, res) => {
  try {
    const { idOrAddress } = req.params;
    const validator = resolveValidator(idOrAddress);
    
    if (!validator) {
      return res.status(404).json({
        success: false,
        error: "Validator not found",
        hint: "Use validator ID (e.g., 1) or Secp address (0x...)"
      });
    }
    
    res.json({
      success: true,
      validator: formatValidator(validator)
    });
  } catch (err) {
    internalError(req, res, err);
  }
});

export default router;
