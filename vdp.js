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


function weekStartTs(weekIndex) {
  return weekIndex * VDP_WEEK_SECONDS + VDP_MONDAY_ANCHOR;
}

function toISO(ts) {
  return ts ? new Date(ts * 1000).toISOString() : null;
}

/** How many complete week buckets fall inside the strike window. */
function expectedWeeks(windowStart, now) {
  let idx = Math.floor((windowStart - VDP_MONDAY_ANCHOR) / VDP_WEEK_SECONDS);
  if (weekStartTs(idx) < windowStart) idx++;
  let count = 0;
  while (weekStartTs(idx) + VDP_WEEK_SECONDS <= now) {
    count++;
    idx++;
  }
  return count;
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
 * much history we hold, but "no strikes" over a window we only partly observed
 * does not establish compliance, so that reports as insufficient_data rather
 * than as a clean bill of health. A validator that leaves the active set stops
 * producing rounds, and its silence must not read as a good record.
 */
export function evaluateCompliance(weeks, commissionPercent, now = Math.floor(Date.now() / 1000)) {
  const windowStart = now - VDP_RULES.strike_window_days * 86400;

  const inWindow = weeks.filter((w) => w.complete && w.week_start >= windowStart);
  const strikes = inWindow.filter((w) => w.flagged).length;

  // weeks arrives newest first, so the last completed entry is the oldest.
  const completedWeeks = weeks.filter((w) => w.complete);
  const completeWeeks = completedWeeks.length;

  // A validator that stops participating produces no rounds, so its weeks are
  // absent rather than bad. Reaching far enough back is therefore not the same
  // as covering the window: count the weeks the window should hold and compare.
  // Anything missing is unobserved, and a verdict cannot be drawn over it.
  const weeksExpected = expectedWeeks(windowStart, now);
  const weeksMissing = Math.max(weeksExpected - inWindow.length, 0);
  const sufficient = weeksMissing === 0;

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
      weeks_expected: weeksExpected,
      // Weeks the window should hold for which no rounds were recorded at all,
      // which is what an inactive validator looks like.
      weeks_missing: weeksMissing,
      last_week_utc: completeWeeks ? completedWeeks[0].week_start_utc : null,
      window_start_utc: toISO(windowStart),
      // True only when every week the window should hold was actually observed.
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
//
// Read at call time, never at module scope: ES module imports are hoisted
// above the body of index.js, so a module-scope read happens before
// dotenv.config() has run and sees nothing.
export function vdpApplies() {
  return (process.env.NETWORK || "").toLowerCase() === "mainnet";
}

const NOTE_BASE =
  "Weeks run Monday 00:00 UTC. Uptime is summed across epochs, not averaged. " +
  "Only completed weeks can count as strikes. The 48h upgrade window and 24h " +
  "outreach response requirements are not measured here.";

export function vdpNote() {
  if (vdpApplies()) return NOTE_BASE;
  return (
    "This deployment is not on mainnet. The Validator Delegation Program " +
    "applies to mainnet only, so these figures are uptime measurements " +
    "rather than programme standing. " + NOTE_BASE
  );
}
