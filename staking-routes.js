// src/staking-routes.js - Staking & Delegation API Routes (Cosmos-inspired)
import { Router } from "express";
import { ethers } from "ethers";
import {
  getValidatorOnChain,
  getDelegatorInfo,
  getAllDelegations,
  getAllDelegators,
  getEpochInfo,
  getLivePool,
  getValidatorSets,
} from "./staking.js";
import { getValidatorById, getValidatorCount, getMeasuredBlockTime } from "./db.js";

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
    const delegatorAddresses = await getAllDelegators(valId);

    // Fetch delegation details for each delegator (batched)
    const delegators = [];
    const batchSize = 10;

    for (let i = 0; i < delegatorAddresses.length; i += batchSize) {
      const batch = delegatorAddresses.slice(i, i + batchSize);
      const promises = batch.map(async (addr) => {
        try {
          const info = await getDelegatorInfo(valId, addr);
          return { address: addr, stake: info.stake, unclaimed_rewards: info.unclaimed_rewards };
        } catch {
          return { address: addr, stake: 0, unclaimed_rewards: 0 };
        }
      });
      const results = await Promise.all(promises);
      delegators.push(...results);
    }

    // Sort by stake descending
    delegators.sort((a, b) => (b.stake || 0) - (a.stake || 0));

    res.json({
      success: true,
      validator_id: valId,
      validator_name: validator?.name || `Validator #${valId}`,
      total_delegators: delegators.length,
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
