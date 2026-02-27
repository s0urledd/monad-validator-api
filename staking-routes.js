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
} from "./staking.js";
import { getValidatorById, getValidatorCount } from "./db.js";

const router = Router();

// ---------- Helpers ----------
function toMON(wei) {
  return parseFloat(parseFloat(ethers.formatEther(BigInt(wei))).toFixed(2));
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

    res.json({
      success: true,
      ...poolData,
      total_validators: getValidatorCount(),
      active_validators: consensus_validators,
      ...(epoch && { epoch: epoch.epoch, in_delay_period: epoch.in_delay_period }),
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
