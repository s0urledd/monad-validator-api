// src/vdp.js - Validator Delegation Program compliance evaluation
//
// Rules, from docs.monad.xyz/node-ops/validator-delegation-program:
//   - uptime must stay above 98%
//   - uptime is evaluated WEEKLY; a week below the threshold is a flag
//   - three flags within a 3 month period warrants removal from the program
//   - VDP commission is capped at 15% (since 2026-04-24)
//
// Two parts of the program are deliberately not modelled here because nothing
// in this dataset can observe them: the 48h upgrade window and the 24h
// response-to-outreach requirement.

import { VDP_WEEK_SECONDS, VDP_MONDAY_ANCHOR } from "./db.js";

export const VDP_RULES = {
  uptime_threshold: 98,
  max_strikes: 3,
  strike_window_days: 90,
  commission_cap: 15,
};

// Counting weeks is the wrong test for "do we have enough history": a 90 day
// window spans 12.86 weeks, so depending on where the boundaries fall only 11
// or 12 completed weeks ever start inside it. What actually matters is whether
// our records reach back past the start of the window.

function weekStartTs(weekIndex) {
  return weekIndex * VDP_WEEK_SECONDS + VDP_MONDAY_ANCHOR;
}

function toISO(ts) {
  return ts ? new Date(ts * 1000).toISOString() : null;
}

/**
 * Turn raw weekly rows into flagged/not-flagged weeks.
 *
 * A week still in progress is reported but never counted as a strike: the
 * Foundation flags completed weeks, and a validator two hours into a bad
 * Monday has not breached anything yet.
 */
export function evaluateWeeks(rows, now = Math.floor(Date.now() / 1000)) {
  return rows.map((r) => {
    const start = weekStartTs(r.week_index);
    const end = start + VDP_WEEK_SECONDS;
    const complete = end <= now;
    const uptime = r.total > 0 ? (r.finalized / r.total) * 100 : 0;

    return {
      week_start: start,
      week_start_utc: toISO(start),
      complete,
      epochs: r.epochs,
      finalized_count: r.finalized,
      timeout_count: r.timeout,
      total_events: r.total,
      uptime_percent: parseFloat(uptime.toFixed(2)),
      // Only a finished week can be a strike.
      flagged: complete && r.total > 0 && uptime < VDP_RULES.uptime_threshold,
    };
  });
}

/**
 * Compliance verdict for one validator.
 *
 * Status is deliberately conservative. Three strikes is a breach no matter how
 * much history we hold, but "no strikes" over four weeks of data does not
 * establish compliance across a 13 week window, so that reports as
 * insufficient_data rather than as a clean bill of health.
 */
export function evaluateCompliance(weeks, commissionPercent, now = Math.floor(Date.now() / 1000)) {
  const windowStart = now - VDP_RULES.strike_window_days * 86400;

  const inWindow = weeks.filter((w) => w.complete && w.week_start >= windowStart);
  const strikes = inWindow.filter((w) => w.flagged).length;

  // weeks arrives newest first, so the last completed entry is the oldest.
  const completedWeeks = weeks.filter((w) => w.complete);
  const completeWeeks = completedWeeks.length;
  const oldestComplete = completeWeeks ? completedWeeks[completeWeeks - 1] : null;
  const sufficient = oldestComplete ? oldestComplete.week_start <= windowStart : false;

  let status;
  if (strikes >= VDP_RULES.max_strikes) {
    status = "breach";
  } else if (!sufficient) {
    status = "insufficient_data";
  } else if (strikes > 0) {
    status = "at_risk";
  } else {
    status = "compliant";
  }

  const commissionCompliant =
    commissionPercent == null ? null : commissionPercent <= VDP_RULES.commission_cap;

  const current = weeks.find((w) => !w.complete) || null;
  const oldest = weeks.length ? weeks[weeks.length - 1] : null;

  // Everything we ever recorded, separate from the formal 90 day verdict.
  // The strike count answers "is this validator in trouble under the rules";
  // this answers "what have we actually seen", which stays meaningful even
  // when the window is short.
  const completed = weeks.filter((w) => w.complete);
  const below = completed.filter((w) => w.flagged);

  let finalized = 0;
  let total = 0;
  for (const w of completed) {
    finalized += w.finalized_count;
    total += w.total_events;
  }

  const worst = completed.reduce(
    (acc, w) => (acc === null || w.uptime_percent < acc.uptime_percent ? w : acc),
    null
  );

  return {
    status,
    observed: {
      since_utc: oldest ? oldest.week_start_utc : null,
      complete_weeks: completed.length,
      weeks_below_threshold: below.length,
      uptime_percent: total > 0 ? parseFloat(((finalized / total) * 100).toFixed(2)) : null,
      worst_week: worst
        ? { week_start_utc: worst.week_start_utc, uptime_percent: worst.uptime_percent }
        : null,
      below_threshold_weeks: below.map((w) => ({
        week_start_utc: w.week_start_utc,
        uptime_percent: w.uptime_percent,
        epochs: w.epochs,
      })),
    },
    uptime: {
      strikes,
      strikes_remaining: Math.max(VDP_RULES.max_strikes - strikes, 0),
      flagged_weeks: inWindow.filter((w) => w.flagged).map((w) => ({
        week_start_utc: w.week_start_utc,
        uptime_percent: w.uptime_percent,
      })),
      current_week: current,
    },
    commission: {
      current: commissionPercent,
      cap: VDP_RULES.commission_cap,
      compliant: commissionCompliant,
    },
    coverage: {
      weeks_available: weeks.length,
      complete_weeks: completeWeeks,
      weeks_in_window: inWindow.length,
      window_start_utc: toISO(windowStart),
      // True when our history reaches back past the start of the strike window,
      // which is what makes a "no strikes" verdict meaningful.
      sufficient,
      since_utc: oldest ? oldest.week_start_utc : null,
    },
  };
}

export function commissionOf(validator) {
  if (!validator?.commission_raw) return null;
  return parseFloat(((Number(validator.commission_raw) / 1e18) * 100).toFixed(2));
}

// The program applies to mainnet. On any other network the weekly uptime is
// still real, but a strike carries no consequence, so the response says so
// rather than presenting a testnet breach as if it mattered.
export const VDP_APPLIES =
  (process.env.NETWORK || "").toLowerCase() === "mainnet";

export const VDP_NOTE =
  (VDP_APPLIES
    ? ""
    : "This deployment is not on mainnet. The Validator Delegation Program " +
      "applies to mainnet only, so these figures are uptime measurements " +
      "rather than programme standing. ") +
  "Weeks run Monday 00:00 UTC. Uptime is summed across epochs, not averaged. " +
  "Only completed weeks can count as strikes. The 48h upgrade window and 24h " +
  "outreach response requirements are not measured here.";
