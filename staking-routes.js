// src/staking-routes.js - Staking & Delegation API Routes (Cosmos-inspired)
import { Router } from "express";
import { ethers } from "ethers";
import {
  getValidatorOnChain,
  getDelegatorInfo,
  getAllDelegations,
  getAllDelegators,
  getEpochInfo,
  getProposer,
} from "./staking.js";
import {
  getValidatorById,
  getAllValidators,
  getStakingPool,
} from "./db.js";

const router = Router();

// ---------- Helpers ----------
function formatMON(wei) {
  return ethers.formatEther(BigInt(wei));
}

// ---------- Epoch ----------

// GET /monad-api/staking/epoch
router.get("/epoch", async (req, res) => {
  try {
    const [epoch, proposerValId] = await Promise.all([
      getEpochInfo(),
      getProposer().catch(() => null),
    ]);

    const proposer = proposerValId ? getValidatorById(proposerValId) : null;

    res.json({
      success: true,
      epoch: epoch.epoch,
      in_delay_period: epoch.in_delay_period,
      current_proposer: proposerValId
        ? {
            validator_id: proposerValId,
            name: proposer?.name || `Validator #${proposerValId}`,
          }
        : null,
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
router.get("/pool", (req, res) => {
  try {
    const pool = getStakingPool();

    res.json({
      success: true,
      bonded_tokens: formatMON(pool.bonded_tokens),
      bonded_tokens_wei: pool.bonded_tokens,
      total_staked: formatMON(pool.total_staked),
      total_staked_wei: pool.total_staked,
      total_validators: pool.total_validators,
      active_validators: pool.active_validators,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

    res.json({
      success: true,
      validator: {
        id: valId,
        name: validator?.name || `Validator #${valId}`,
        secp_address: validator?.secp_address || null,
        status: validator?.status || "unknown",
        stake: onChain.stake,
        stake_wei: onChain.stake_wei,
        commission: onChain.commission,
        commission_raw: onChain.commission_raw,
        unclaimed_rewards: onChain.unclaimed_rewards,
        unclaimed_rewards_wei: onChain.unclaimed_rewards_wei,
        acc_reward_per_token: onChain.acc_reward_per_token,
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

// ---------- Validator Commission ----------

// GET /monad-api/staking/validator/:valId/commission
router.get("/validator/:valId/commission", async (req, res) => {
  try {
    const valId = parseInt(req.params.valId);
    if (isNaN(valId) || valId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid validator ID" });
    }

    const validator = getValidatorById(valId);
    const onChain = await getValidatorOnChain(valId);

    res.json({
      success: true,
      validator_id: valId,
      validator_name: validator?.name || `Validator #${valId}`,
      commission: onChain.commission,
      commission_raw: onChain.commission_raw,
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: "Failed to query commission",
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
          return { address: addr, ...info };
        } catch {
          return { address: addr, stake: "0", unclaimed_rewards: "0" };
        }
      });
      const results = await Promise.all(promises);
      delegators.push(...results);
    }

    // Sort by stake descending
    delegators.sort((a, b) => {
      const sa = BigInt(a.stake_wei || "0");
      const sb = BigInt(b.stake_wei || "0");
      if (sb > sa) return 1;
      if (sb < sa) return -1;
      return 0;
    });

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
        totalStaked += BigInt(info.stake_wei);
        totalRewards += BigInt(info.unclaimed_rewards_wei);

        delegations.push({
          validator_id: valId,
          validator_name: validator?.name || `Validator #${valId}`,
          validator_status: validator?.status || "unknown",
          ...info,
        });
      } catch {
        delegations.push({
          validator_id: valId,
          stake: "0",
          unclaimed_rewards: "0",
        });
      }
    }

    res.json({
      success: true,
      address: checksumAddress,
      total_staked: ethers.formatEther(totalStaked),
      total_staked_wei: totalStaked.toString(),
      total_unclaimed_rewards: ethers.formatEther(totalRewards),
      total_unclaimed_rewards_wei: totalRewards.toString(),
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

// ---------- Delegator Rewards ----------

// GET /monad-api/staking/delegator/:address/rewards
router.get("/delegator/:address/rewards", async (req, res) => {
  try {
    const address = req.params.address;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ success: false, error: "Invalid Ethereum address" });
    }

    const checksumAddress = ethers.getAddress(address);
    const valIds = await getAllDelegations(checksumAddress);

    const rewards = [];
    let totalRewards = 0n;

    for (const valId of valIds) {
      try {
        const info = await getDelegatorInfo(valId, checksumAddress);
        const validator = getValidatorById(valId);
        const rewardWei = BigInt(info.unclaimed_rewards_wei);

        if (rewardWei > 0n) {
          totalRewards += rewardWei;
          rewards.push({
            validator_id: valId,
            validator_name: validator?.name || `Validator #${valId}`,
            reward: info.unclaimed_rewards,
            reward_wei: info.unclaimed_rewards_wei,
          });
        }
      } catch {
        // skip failed queries
      }
    }

    res.json({
      success: true,
      address: checksumAddress,
      total_rewards: ethers.formatEther(totalRewards),
      total_rewards_wei: totalRewards.toString(),
      validator_count: rewards.length,
      rewards,
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: "Failed to query rewards",
      details: err.message,
    });
  }
});

// ---------- Delegator -> Specific Validator ----------

// GET /monad-api/staking/delegator/:address/validator/:valId
router.get("/delegator/:address/validator/:valId", async (req, res) => {
  try {
    const address = req.params.address;
    const valId = parseInt(req.params.valId);

    if (!ethers.isAddress(address)) {
      return res.status(400).json({ success: false, error: "Invalid Ethereum address" });
    }
    if (isNaN(valId) || valId <= 0) {
      return res.status(400).json({ success: false, error: "Invalid validator ID" });
    }

    const checksumAddress = ethers.getAddress(address);
    const validator = getValidatorById(valId);
    const info = await getDelegatorInfo(valId, checksumAddress);

    res.json({
      success: true,
      address: checksumAddress,
      validator_id: valId,
      validator_name: validator?.name || `Validator #${valId}`,
      validator_status: validator?.status || "unknown",
      ...info,
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: "Failed to query delegation",
      details: err.message,
    });
  }
});

export default router;
