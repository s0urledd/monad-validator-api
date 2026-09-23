// src/staking-routes.js - Staking & Delegation API Routes (Cosmos-inspired)
import { Router } from "express";
import { ethers } from "ethers";
import {
  getValidatorOnChain,
  getDelegatorInfo,
  getAllDelegations,
  getAllDelegators,
  getDelegatorsPage,
  getEpochInfo,
  getLivePool,
  getValidatorSets,
  getProposer,
} from "./staking.js";
import {
  getValidatorById,
  getValidatorCount,
  getMeasuredBlockTime,
  getStakingEvents,
  getValidatorEpochRewards,
  getIndexerStats,
  getStakeFlowRows,
  getEpochBlockRewards,
  getBlocksProposedTotals,
  getBlocksPerEpoch,
} from "./db.js";

const router = Router();

// ---------- Helpers ----------
function toMON(wei) {
  return parseFloat(parseFloat(ethers.formatEther(BigInt(wei))).toFixed(2));
}

// ---------- APR ----------
// Docs: a fixed REWARD of 18 MON per block, and 50,000 blocks per epoch at
// roughly 4h12m, which implies ~0.3024s per block.
const BLOCK_REWARD_MON = 18;
const ASSUMED_BLOCK_TIME_S = 0.3024;
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

function aprFrom(blockTimeSeconds, bondedTokens) {
  if (!blockTimeSeconds || !bondedTokens || bondedTokens <= 0) return null;
  const blocksPerYear = SECONDS_PER_YEAR / blockTimeSeconds;
  return parseFloat(((blocksPerYear * BLOCK_REWARD_MON) / bondedTokens * 100).toFixed(2));
}

// ---------- Epoch ----------

// GET /monad-api/staking/epoch
router.get("/epoch", async (req, res) => {
  try {
    const epoch = await getEpochInfo();

    res.json({
      success: true,
      epoch: epoch.epoch,
      in_delay_period: epoch.in_delay_period,
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: "Failed to query epoch info",
      details: err.message,
    });
  }
});

// ---------- Pool ----------

// GET /monad-api/staking/pool
router.get("/pool", async (req, res) => {
  try {
    const [pool, epoch] = await Promise.all([
      getLivePool(),
      getEpochInfo().catch(() => null),
    ]);

    const { consensus_validators, execution_validators, ...poolData } = pool;

    // Rewards only go to active consensus validators, so bonded_tokens is the denominator.
    // Two figures are published rather than one: a hardcoded block time is the classic way
    // to be silently wrong about yield, so the assumed and the measured values are both
    // returned along with every input, and the number stays auditable.
    const measuredBlockTime = getMeasuredBlockTime();
    const estimated_apr = aprFrom(ASSUMED_BLOCK_TIME_S, poolData.bonded_tokens);
    const calculated_apr = aprFrom(measuredBlockTime, poolData.bonded_tokens);

    res.json({
      success: true,
      ...poolData,
      apr: calculated_apr ?? estimated_apr,
      estimated_apr,
      calculated_apr,
      apr_inputs: {
        block_reward: BLOCK_REWARD_MON,
        assumed_block_time: ASSUMED_BLOCK_TIME_S,
        measured_block_time: measuredBlockTime
          ? parseFloat(measuredBlockTime.toFixed(4))
          : null,
        blocks_per_year: Math.round(
          SECONDS_PER_YEAR / (measuredBlockTime || ASSUMED_BLOCK_TIME_S)
        ),
        bonded_tokens: poolData.bonded_tokens,
        note: "Commission applies to inflation rewards only; priority fees currently go entirely to the validator.",
      },
      total_validators: getValidatorCount(),
      active_validators: consensus_validators,
      ...(epoch && { epoch: epoch.epoch, in_delay_period: epoch.in_delay_period }),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Events ----------

const EVENT_TYPES = [
  "Delegate",
  "Undelegate",
  "Withdraw",
  "ClaimRewards",
  "CommissionChanged",
  "ValidatorCreated",
  "ValidatorStatusChanged",
  "EpochChanged",
];

function formatEvent(e) {
  let extra = null;
  try {
    extra = e.extra ? JSON.parse(e.extra) : null;
  } catch {
    // keep null on malformed extra rather than failing the whole response
  }

  return {
    block_number: e.block_number,
    tx_hash: e.tx_hash,
    event_type: e.event_type,
    validator_id: e.validator_id,
    address: e.address,
    amount: e.amount_wei ? toMON(e.amount_wei) : null,
    epoch: e.epoch,
    timestamp: e.block_ts,
    utc: e.block_ts ? new Date(e.block_ts * 1000).toISOString() : null,
    ...(extra && { details: extra }),
  };
}

// GET /monad-api/staking/events
router.get("/events", (req, res) => {
  try {
    const eventType = req.query.type;
    if (eventType && !EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({
        success: false,
        error: "Invalid event type",
        hint: `Use one of: ${EVENT_TYPES.join(", ")}`,
      });
    }

    const limit = Number(req.query.limit) || 50;
    const events = getStakingEvents({
      eventType,
      address: req.query.address,
      limit,
    });

    res.json({
      success: true,
      indexer: getIndexerStats(),
      count: events.length,
      events: events.map(formatEvent),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /monad-api/staking/validator/:valId/events
router.get("/validator/:valId/events", (req, res) => {
  try {
    const valId = parseInt(req.params.valId);
    if (isNaN(valId) || valId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid validator ID" });
    }

    const eventType = req.query.type;
    if (eventType && !EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({
        success: false,
        error: "Invalid event type",
        hint: `Use one of: ${EVENT_TYPES.join(", ")}`,
      });
    }

    const events = getStakingEvents({
      validatorId: valId,
      eventType,
      limit: Number(req.query.limit) || 50,
    });

    res.json({
      success: true,
      validator_id: valId,
      indexer: getIndexerStats(),
      count: events.length,
      events: events.map(formatEvent),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /monad-api/staking/validator/:valId/rewards
// ValidatorRewarded carries the delegators' share of a block reward, not the
// whole reward: the amount is reward x (1 - commission). The gross figure and
// the validator's commission are therefore derived, using the block reward
// observed for that epoch rather than a constant, since it has changed over
// the chain's life (0, then 25, then 18 MON on mainnet).
const monToWei = (mon) => BigInt(Math.round(mon * 1e6)) * 10n ** 12n;

function epochRewardView(r, blockReward) {
  const base = {
    epoch: r.epoch,
    first_block: r.first_block,
    last_block: r.last_block,
  };
  if (r.block_count === null) {
    // Indexed before block and external rewards were told apart, and not yet
    // rebuilt from an archive. The total is right; the split is unknown.
    return { ...base, split_known: false, reward_events: r.event_count, total_rewards: toMON(r.reward_wei) };
  }
  const delegator = BigInt(r.block_reward_wei);
  const gross = blockReward == null ? null : BigInt(r.block_count) * monToWei(blockReward);
  return {
    ...base,
    split_known: true,
    blocks_proposed: r.block_count,
    block_reward: blockReward,
    gross_rewards: gross === null ? null : toMON(gross),
    delegator_rewards: toMON(delegator),
    commission_rewards: gross === null ? null : toMON(gross - delegator),
    external_rewards: toMON(r.external_wei),
    external_reward_count: r.external_count,
  };
}

// GET /monad-api/staking/validator/:valId/rewards
router.get("/validator/:valId/rewards", (req, res) => {
  try {
    const valId = parseInt(req.params.valId);
    if (isNaN(valId) || valId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid validator ID" });
    }

    const rows = getValidatorEpochRewards(valId, Number(req.query.limit) || 100);
    const rewardByEpoch = getEpochBlockRewards(rows.map((r) => r.epoch));
    const epochs = rows.map((r) => epochRewardView(r, rewardByEpoch.get(r.epoch)));

    const totals = { blocks: 0, gross: 0n, delegator: 0n, external: 0n, externalCount: 0 };
    for (const r of rows) {
      if (r.block_count === null) continue;
      totals.blocks += r.block_count;
      totals.delegator += BigInt(r.block_reward_wei);
      totals.external += BigInt(r.external_wei);
      totals.externalCount += r.external_count;
      const reward = rewardByEpoch.get(r.epoch);
      if (reward != null) totals.gross += BigInt(r.block_count) * monToWei(reward);
    }
    const allTime = getBlocksProposedTotals().find((t) => t.validator_id === valId) || null;

    res.json({
      success: true,
      validator_id: valId,
      indexer: getIndexerStats(),
      epochs_covered: rows.length,
      epochs_split_unknown: rows.filter((r) => r.block_count === null).length,
      blocks_proposed: totals.blocks,
      gross_rewards: toMON(totals.gross),
      delegator_rewards: toMON(totals.delegator),
      commission_rewards: toMON(totals.gross - totals.delegator),
      external_rewards: toMON(totals.external),
      external_reward_count: totals.externalCount,
      derived: ["gross_rewards", "commission_rewards"],
      all_time: allTime && {
        blocks_proposed: allTime.blocks,
        first_epoch: allTime.first_epoch,
        last_epoch: allTime.last_epoch,
      },
      epochs,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /monad-api/staking/blocks
// Blocks proposed per validator, from the block reward each block pays its
// proposer. These are finalized blocks: a round that timed out produced no
// block and appears nowhere here, which is why this is not an uptime figure.
router.get("/blocks", (req, res) => {
  try {
    const since = req.query.since_epoch != null ? parseInt(req.query.since_epoch) : null;
    if (req.query.since_epoch != null && (isNaN(since) || since < 0)) {
      return res.status(400).json({ success: false, error: "since_epoch must be a non-negative integer" });
    }

    const perEpoch = getBlocksPerEpoch();
    const known = perEpoch.filter((e) => e.blocks !== null && (since == null || e.epoch >= since));
    const unsplit = perEpoch.filter((e) => e.blocks === null && (since == null || e.epoch >= since)).map((e) => e.epoch);

    const validators = getBlocksProposedTotals(since).map((t) => ({
      validator_id: t.validator_id,
      name: getValidatorById(t.validator_id)?.name || `Validator #${t.validator_id}`,
      blocks_proposed: t.blocks,
      first_epoch: t.first_epoch,
      last_epoch: t.last_epoch,
      epochs_with_blocks: t.epochs_with_blocks,
    }));

    // Epochs with no rows at all between the first and the last one held.
    // A full backfill leaves none; until then the totals undercount.
    const first = known.length ? known[0].epoch : null;
    const last = known.length ? known[known.length - 1].epoch : null;
    const held = new Set(perEpoch.map((e) => e.epoch));
    const missing = [];
    if (first !== null) for (let ep = first; ep <= last; ep++) if (!held.has(ep)) missing.push(ep);

    res.json({
      success: true,
      coverage: {
        first_epoch: first,
        last_epoch: last,
        total_blocks: known.reduce((s, e) => s + e.blocks, 0),
        epochs_missing: missing.length,
        complete: first !== null && missing.length === 0 && unsplit.length === 0,
        // Epochs indexed before block and external rewards were told apart.
        // They are left out of the counts until rebuilt from an archive.
        epochs_not_split: unsplit,
      },
      count: validators.length,
      validators,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Stake Flow ----------

const FLOW_PERIODS = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, all: null };

function flowSince(req) {
  const period = req.query.period || "7d";
  if (!(period in FLOW_PERIODS)) return { error: period };
  const secs = FLOW_PERIODS[period];
  return { period, since: secs === null ? null : Math.floor(Date.now() / 1000) - secs };
}

// Net stake movement from indexed Delegate and Undelegate events. Sums run in
// BigInt because a single validator's inflow can exceed the exact range of a
// double once it is expressed in wei.
function aggregateFlow(rows) {
  const acc = new Map();
  for (const r of rows) {
    let a = acc.get(r.validator_id);
    if (!a) {
      a = { inWei: 0n, outWei: 0n, delegations: 0, undelegations: 0, delegators: new Set() };
      acc.set(r.validator_id, a);
    }
    const amt = BigInt(r.amount_wei || "0");
    if (r.event_type === "Delegate") {
      a.inWei += amt;
      a.delegations++;
      a.delegators.add(r.address);
    } else {
      a.outWei += amt;
      a.undelegations++;
    }
  }
  return acc;
}

function formatFlow(a) {
  return {
    inflow: toMON(a.inWei),
    outflow: toMON(a.outWei),
    net: toMON(a.inWei - a.outWei),
    delegations: a.delegations,
    undelegations: a.undelegations,
    unique_delegators: a.delegators.size,
  };
}

// GET /monad-api/staking/flow
router.get("/flow", (req, res) => {
  try {
    const f = flowSince(req);
    if (f.error) {
      return res.status(400).json({
        success: false,
        error: "Invalid period",
        hint: `Use one of: ${Object.keys(FLOW_PERIODS).join(", ")}`,
      });
    }

    const acc = aggregateFlow(getStakeFlowRows(null, f.since));
    const network = { inWei: 0n, outWei: 0n, delegations: 0, undelegations: 0, delegators: new Set() };
    const validators = [];

    for (const [id, a] of acc) {
      network.inWei += a.inWei;
      network.outWei += a.outWei;
      network.delegations += a.delegations;
      network.undelegations += a.undelegations;
      for (const d of a.delegators) network.delegators.add(d);
      const v = getValidatorById(id);
      validators.push({
        validator_id: id,
        name: v?.name || `Validator #${id}`,
        ...formatFlow(a),
      });
    }

    // Largest net movement first, in either direction.
    validators.sort((x, y) => Math.abs(y.net) - Math.abs(x.net));

    res.json({
      success: true,
      period: f.period,
      indexer: getIndexerStats(),
      network: formatFlow(network),
      count: validators.length,
      validators,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /monad-api/staking/validator/:valId/flow
router.get("/validator/:valId/flow", (req, res) => {
  try {
    const valId = parseInt(req.params.valId);
    if (isNaN(valId) || valId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid validator ID" });
    }
    const f = flowSince(req);
    if (f.error) {
      return res.status(400).json({
        success: false,
        error: "Invalid period",
        hint: `Use one of: ${Object.keys(FLOW_PERIODS).join(", ")}`,
      });
    }

    const acc = aggregateFlow(getStakeFlowRows(valId, f.since));
    const a = acc.get(valId) || {
      inWei: 0n, outWei: 0n, delegations: 0, undelegations: 0, delegators: new Set(),
    };
    const v = getValidatorById(valId);

    res.json({
      success: true,
      validator_id: valId,
      validator_name: v?.name || `Validator #${valId}`,
      period: f.period,
      indexer: getIndexerStats(),
      flow: formatFlow(a),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Proposer ----------

// GET /monad-api/staking/proposer
router.get("/proposer", async (req, res) => {
  try {
    const valId = await getProposer();
    const v = getValidatorById(valId);

    res.json({
      success: true,
      proposer: {
        validator_id: valId,
        name: v?.name || `Validator #${valId}`,
        secp_address: v?.secp_address || null,
        status: v?.status || "unknown",
      },
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: "Failed to query current proposer",
      details: err.message,
    });
  }
});

// ---------- Validator Set ----------

function describeValidators(ids) {
  return ids.map((id) => {
    const v = getValidatorById(id);
    return {
      validator_id: id,
      name: v?.name || `Validator #${id}`,
      stake: v?.stake_wei ? toMON(v.stake_wei) : null,
    };
  });
}

// GET /monad-api/staking/validator-set
router.get("/validator-set", async (req, res) => {
  try {
    const [sets, epoch] = await Promise.all([
      getValidatorSets(),
      getEpochInfo().catch(() => null),
    ]);

    const consensus = new Set(sets.consensus);
    const snapshot = new Set(sets.snapshot);

    // snapshot is next epoch's set, consensus is this epoch's
    const entering = sets.snapshot.filter((id) => !consensus.has(id));
    const leaving = sets.consensus.filter((id) => !snapshot.has(id));
    const eligibleNotActive = sets.execution.filter(
      (id) => !consensus.has(id) && !snapshot.has(id)
    );

    res.json({
      success: true,
      ...(epoch && { epoch: epoch.epoch, in_delay_period: epoch.in_delay_period }),
      counts: {
        active: sets.consensus.length,
        next_epoch: sets.snapshot.length,
        eligible: sets.execution.length,
        entering: entering.length,
        leaving: leaving.length,
        eligible_not_active: eligibleNotActive.length,
      },
      entering: describeValidators(entering),
      leaving: describeValidators(leaving),
      eligible_not_active: describeValidators(eligibleNotActive),
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: "Failed to query validator sets",
      details: err.message,
    });
  }
});

// ---------- Validator On-Chain ----------

// GET /monad-api/staking/validator/:valId
router.get("/validator/:valId", async (req, res) => {
  try {
    const valId = parseInt(req.params.valId);
    if (isNaN(valId) || valId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid validator ID" });
    }

    const validator = getValidatorById(valId);
    const onChain = await getValidatorOnChain(valId);

    // Query auth_address's delegation rewards
    let authDelegation = null;
    if (onChain.auth_address && onChain.auth_address !== ethers.ZeroAddress) {
      try {
        authDelegation = await getDelegatorInfo(valId, onChain.auth_address);
      } catch {
        // auth_address may not be a delegator
      }
    }

    res.json({
      success: true,
      validator: {
        id: valId,
        name: validator?.name || `Validator #${valId}`,
        secp_address: validator?.secp_address || null,
        status: validator?.status || "unknown",
        stake: onChain.stake,
        commission: onChain.commission,
        // The auth address's own delegation is the validator's self-stake, which the
        // active set requires to be at least MIN_AUTH_ADDRESS_STAKE (100,000 MON).
        self_stake: authDelegation ? authDelegation.stake : null,
        unclaimed_rewards: authDelegation ? authDelegation.unclaimed_rewards : 0,
        auth_address: onChain.auth_address,
        // consensus_* is what is active this epoch, snapshot_* is what takes effect
        // next epoch. Their difference is a change that has been committed on-chain
        // but has not activated yet.
        consensus_stake: onChain.consensus_stake,
        snapshot_stake: onChain.snapshot_stake,
        consensus_commission: onChain.consensus_commission,
        snapshot_commission: onChain.snapshot_commission,
        pending: {
          stake_delta: parseFloat(
            (onChain.snapshot_stake - onChain.consensus_stake).toFixed(2)
          ),
          commission_change:
            onChain.snapshot_commission !== onChain.consensus_commission
              ? { from: onChain.consensus_commission, to: onChain.snapshot_commission }
              : null,
        },
      },
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: "Failed to query validator on-chain data",
      details: err.message,
    });
  }
});

// ---------- Validator Delegators ----------

// GET /monad-api/staking/validator/:valId/delegators
router.get("/validator/:valId/delegators", async (req, res) => {
  try {
    const valId = parseInt(req.params.valId);
    if (isNaN(valId) || valId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid validator ID" });
    }

    const validator = getValidatorById(valId);

    // Walk the precompile's pagination only as far as this page needs. Fetching
    // every delegator turned one HTTP request into an unbounded number of RPC
    // calls, which is exactly what the staking docs warn against.
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const cursor = req.query.cursor;
    if (cursor && !ethers.isAddress(cursor)) {
      return res.status(400).json({
        success: false,
        error: "Invalid cursor",
        hint: "Pass the next_cursor value from a previous response",
      });
    }

    const addresses = [];
    let next = cursor ? ethers.getAddress(cursor) : ethers.ZeroAddress;
    let done = false;
    const startedAtBeginning = !cursor;

    while (addresses.length < limit && !done) {
      const page = await getDelegatorsPage(valId, next);
      addresses.push(...page.delegators);
      done = page.isDone;
      next = page.nextDelegator;
    }

    const pageAddresses = addresses.slice(0, limit);

    // Pages arrive in fixed-size chunks, so the last one can overshoot the
    // requested limit. When that happens the next cursor is the first address
    // we did not return, not the precompile's nextDelegator, which already
    // points past everything we fetched.
    const hasMore = addresses.length > limit || !done;
    const nextCursor = hasMore ? (addresses[limit] ?? next) : null;

    const delegators = [];
    const batchSize = 10;
    for (let i = 0; i < pageAddresses.length; i += batchSize) {
      const batch = pageAddresses.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (addr) => {
          try {
            const info = await getDelegatorInfo(valId, addr);
            return { address: addr, stake: info.stake, unclaimed_rewards: info.unclaimed_rewards };
          } catch {
            return { address: addr, stake: 0, unclaimed_rewards: 0 };
          }
        })
      );
      delegators.push(...results);
    }

    // Sorting applies within the page; the precompile orders by address.
    delegators.sort((a, b) => (b.stake || 0) - (a.stake || 0));

    res.json({
      success: true,
      validator_id: valId,
      validator_name: validator?.name || `Validator #${valId}`,
      count: delegators.length,
      // Only meaningful when a single request covered the whole set; otherwise
      // the total is unknown without walking every page.
      total_delegators: startedAtBeginning && !hasMore ? delegators.length : null,
      next_cursor: nextCursor,
      delegators,
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: "Failed to query delegators",
      details: err.message,
    });
  }
});

// ---------- Delegator Delegations ----------

// GET /monad-api/staking/delegator/:address
router.get("/delegator/:address", async (req, res) => {
  try {
    const address = req.params.address;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ success: false, error: "Invalid Ethereum address" });
    }

    const checksumAddress = ethers.getAddress(address);
    const valIds = await getAllDelegations(checksumAddress);

    // Fetch delegation details for each validator
    const delegations = [];
    let totalStaked = 0n;
    let totalRewards = 0n;

    for (const valId of valIds) {
      try {
        const info = await getDelegatorInfo(valId, checksumAddress);
        const validator = getValidatorById(valId);
        totalStaked += info._stake_wei;
        totalRewards += info._unclaimed_rewards_wei;

        delegations.push({
          validator_id: valId,
          validator_name: validator?.name || `Validator #${valId}`,
          validator_status: validator?.status || "unknown",
          stake: info.stake,
          unclaimed_rewards: info.unclaimed_rewards,
        });
      } catch {
        delegations.push({
          validator_id: valId,
          stake: 0,
          unclaimed_rewards: 0,
        });
      }
    }

    res.json({
      success: true,
      address: checksumAddress,
      total_staked: toMON(totalStaked),
      total_rewards: toMON(totalRewards),
      delegation_count: delegations.length,
      delegations,
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: "Failed to query delegations",
      details: err.message,
    });
  }
});

export default router;
