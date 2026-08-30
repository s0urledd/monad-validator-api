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
  getAllCumulativeUptime
} from "./db.js";

const router = Router();

const CUMULATIVE_PERIODS = ["30d", "90d", "all"];

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
    commission: v.commission_raw ? parseFloat((Number(v.commission_raw) / 1e18 * 100).toFixed(2)) : null,
    unclaimed_rewards: v.unclaimed_rewards_wei ? toMON(v.unclaimed_rewards_wei) : null,
    updated_at: toISO(Math.max(v.updated_at || 0, v.status_updated_at || 0) || null)
  };
}

function formatUptime(stats, validator, lastEvent = null) {
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
    last_block_height: getLastFinalizedHeight(validator.id),
    since_timestamp: stats.since_timestamp,
    since_utc: new Date(stats.since_timestamp * 1000).toISOString()
  };
}

// ---------- Routes ----------

// GET /monad-api/validators
router.get("/", (req, res) => {
  try {
    const validators = getAllValidators();
    res.json({
      success: true,
      count: validators.length,
      validators: validators.map(formatValidator)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /monad-api/validators/stats
router.get("/stats", (req, res) => {
  try {
    const count = getValidatorCount();
    res.json({
      success: true,
      total_validators: count,
      api_version: "1.0.0"
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /monad-api/validators/uptime/:idOrAddress/history
router.get("/uptime/:idOrAddress/history", (req, res) => {
  try {
    const { idOrAddress } = req.params;
    const limit = Math.min(Math.max(Number(req.query.limit) || 49, 1), 100);
    
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /monad-api/validators/uptime
// ?period=30d|90d|all  -> cumulative, from permanent epoch snapshots
// ?window=1-168        -> rolling window over raw events (default)
router.get("/uptime", (req, res) => {
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

      const byId = new Map(getAllValidators().map((v) => [v.id, v]));
      let rows = getAllCumulativeUptime(period).map((r) => {
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

      if (sortBy === "id") {
        rows.sort((a, b) => a.validator_id - b.validator_id);
      } else {
        rows.sort((a, b) => b.uptime_percent - a.uptime_percent);
      }

      return res.json({
        success: true,
        period,
        count: rows.length,
        validators: rows
      });
    }

    const validators = getAllValidators();
    let results = validators.map(v => {
      const stats = getUptimeStats(v.id, windowHours);
      const recentEvents = getRecentEvents(v.id, 1);
      const lastEvent = recentEvents.length > 0 ? recentEvents[0] : null;
      return formatUptime(stats, v, lastEvent);
    });
    
    if (sortBy === "uptime") {
      results.sort((a, b) => b.uptime_percent - a.uptime_percent);
    } else if (sortBy === "id") {
      results.sort((a, b) => a.validator_id - b.validator_id);
    }
    
    res.json({
      success: true,
      window_hours: windowHours,
      count: results.length,
      validators: results
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
