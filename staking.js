// src/staking.js - Live staking precompile query service
import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";

const MONAD_RPC_URL = process.env.MONAD_RPC_URL || "http://127.0.0.1:8080";
const STAKING_ADDRESS = "0x0000000000000000000000000000000000001000";

const STAKING_ABI = [
  // Validator info
  "function getValidator(uint64 valId) external returns (address auth_address, uint256 flags, uint256 stake, uint256 acc_reward_per_token, uint256 commission, uint256 unclaimed_rewards, uint256 consensus_stake, uint256 consensus_commission, uint256 snapshot_stake, uint256 snapshot_commission, bytes secp_pubkey, bytes bls_pubkey)",
  // Delegator info
  "function getDelegator(uint64 validatorId, address delegator) external returns (uint256 stake, uint256 accRewardPerToken, uint256 unclaimedRewards, int256 deltaStake, int256 nextDeltaStake, uint64 deltaEpoch, uint64 nextDeltaEpoch)",
  // Delegations for a delegator (paginated)
  "function getDelegations(address delegator, uint64 startValId) external returns (bool isDone, uint64 nextValId, uint64[] valIds)",
  // Delegators for a validator (paginated)
  "function getDelegators(uint64 validatorId, address startDelegator) external returns (bool isDone, address nextDelegator, address[] delegators)",
  // Withdrawal request
  "function getWithdrawalRequest(uint64 validatorId, address delegator, uint64 withdrawId) external returns (uint256 withdrawalAmount, uint256 accRewardPerToken, uint64 withdrawEpoch)",
  // Epoch info
  "function getEpoch() external returns (uint64 epoch, bool inEpochDelayPeriod)",
  // Current block proposer
  "function getProposerValId() external returns (uint64)",
  // Validator sets (paginated)
  "function getExecutionValidatorSet(uint32 startIndex) external returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
  "function getConsensusValidatorSet(uint32 startIndex) external returns (bool isDone, uint32 nextIndex, uint64[] valIds)",
];

// ---------- Helpers ----------
function toMON(wei) {
  return parseFloat(parseFloat(ethers.formatEther(BigInt(wei))).toFixed(2));
}

// ---------- Cache ----------
const CACHE_TTL_MS = 30_000;
const _cache = new Map();

function cached(key, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.p;
  const p = fn().catch((err) => { _cache.delete(key); throw err; });
  _cache.set(key, { p, ts: Date.now() });
  return p;
}

// ---------- Provider Management ----------
let _provider = null;
let _contract = null;

function getContract() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
    _contract = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, _provider);
  }
  return _contract;
}

// ---------- Validator Queries ----------

export function getValidatorOnChain(valId) {
  return cached(`validator:${valId}`, async () => {
    const contract = getContract();
    const info = await contract.getValidator.staticCall(valId);
    return {
      stake: toMON(info.stake),
      commission: parseFloat((Number(info.commission) / 1e18 * 100).toFixed(2)),
      unclaimed_rewards: toMON(info.unclaimed_rewards),
      consensus_stake: toMON(info.consensus_stake),
      consensus_commission: parseFloat((Number(info.consensus_commission) / 1e18 * 100).toFixed(2)),
      snapshot_stake: toMON(info.snapshot_stake),
      snapshot_commission: parseFloat((Number(info.snapshot_commission) / 1e18 * 100).toFixed(2)),
      auth_address: info.auth_address,
      _raw: {
        stake_wei: info.stake.toString(),
        commission_raw: info.commission.toString(),
        unclaimed_rewards_wei: info.unclaimed_rewards.toString(),
      },
    };
  });
}

// ---------- Delegator Queries ----------

export function getDelegatorInfo(valId, delegatorAddress) {
  return cached(`delegator:${valId}:${delegatorAddress}`, async () => {
    const contract = getContract();
    const result = await contract.getDelegator.staticCall(valId, delegatorAddress);
    return {
      stake: toMON(result[0]),
      unclaimed_rewards: toMON(result[2]),
      _stake_wei: result[0],
      _unclaimed_rewards_wei: result[2],
    };
  });
}

export function getAllDelegations(delegatorAddress) {
  return cached(`delegations:${delegatorAddress}`, async () => {
    const contract = getContract();
    const valIds = [];
    let startValId = 0;
    let isDone = false;

    while (!isDone) {
      const result = await contract.getDelegations.staticCall(delegatorAddress, startValId);
      isDone = result[0];
      startValId = Number(result[1]);
      const ids = result[2].map((id) => Number(id));
      valIds.push(...ids);
    }

    return valIds;
  });
}

export function getAllDelegators(valId) {
  return cached(`delegators:${valId}`, async () => {
    const contract = getContract();
    const delegators = [];
    let startDelegator = ethers.ZeroAddress;
    let isDone = false;

    while (!isDone) {
      const result = await contract.getDelegators.staticCall(valId, startDelegator);
      isDone = result[0];
      startDelegator = result[1];
      delegators.push(...result[2]);
    }

    return delegators;
  });
}

// ---------- Epoch & Proposer ----------

export function getEpochInfo() {
  return cached("epoch", async () => {
    const contract = getContract();
    const result = await contract.getEpoch.staticCall();
    return {
      epoch: Number(result[0]),
      in_delay_period: result[1],
    };
  });
}

export async function getProposer() {
  const contract = getContract();
  const valId = await contract.getProposerValId.staticCall();
  return Number(valId);
}

// ---------- Validator Set Queries ----------

function getExecutionValidatorSet() {
  return cached("exec-val-set", async () => {
    const contract = getContract();
    const ids = [];
    let startIndex = 0;
    let isDone = false;

    while (!isDone) {
      const result = await contract.getExecutionValidatorSet.staticCall(startIndex);
      isDone = result[0];
      startIndex = Number(result[1]);
      ids.push(...result[2].map((id) => Number(id)));
    }
    return ids;
  });
}

function getConsensusValidatorSet() {
  return cached("consensus-val-set", async () => {
    const contract = getContract();
    const ids = [];
    let startIndex = 0;
    let isDone = false;

    while (!isDone) {
      const result = await contract.getConsensusValidatorSet.staticCall(startIndex);
      isDone = result[0];
      startIndex = Number(result[1]);
      ids.push(...result[2].map((id) => Number(id)));
    }
    return ids;
  });
}

// ---------- Live Pool ----------

const POOL_CACHE_TTL_MS = 60_000;

export function getLivePool() {
  return cached("live-pool", async () => {
    const contract = getContract();

    // Get both validator sets
    const [execIds, consensusIds] = await Promise.all([
      getExecutionValidatorSet(),
      getConsensusValidatorSet(),
    ]);

    const consensusSet = new Set(consensusIds);
    const allIds = [...new Set([...execIds, ...consensusIds])];

    // Batch query all validators
    let totalStaked = 0n;
    let bondedTokens = 0n;
    let pendingStake = 0n;
    let pendingUnstake = 0n;
    let activeCount = 0;
    const batchSize = 20;

    for (let i = 0; i < allIds.length; i += batchSize) {
      const batch = allIds.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (valId) => {
          try {
            const info = await contract.getValidator.staticCall(valId);
            return { valId, stake: info.stake, consensus_stake: info.consensus_stake };
          } catch {
            return null;
          }
        })
      );

      for (const r of results) {
        if (!r) continue;
        totalStaked += r.stake;
        if (consensusSet.has(r.valId)) {
          bondedTokens += r.consensus_stake;
          activeCount++;
        }
        if (r.stake > r.consensus_stake) {
          pendingStake += r.stake - r.consensus_stake;
        } else if (r.consensus_stake > r.stake) {
          pendingUnstake += r.consensus_stake - r.stake;
        }
      }
    }

    return {
      bonded_tokens: toMON(bondedTokens),
      total_staked: toMON(totalStaked),
      pending_stake: toMON(pendingStake),
      pending_unstake: toMON(pendingUnstake),
      total_validators: allIds.length,
      active_validators: activeCount,
    };
  });
}

// ---------- Batch Queries ----------

export async function getValidatorsBatch(valIds, batchSize = 10) {
  const results = {};
  for (let i = 0; i < valIds.length; i += batchSize) {
    const batch = valIds.slice(i, i + batchSize);
    const promises = batch.map(async (valId) => {
      try {
        const info = await getValidatorOnChain(valId);
        results[valId] = info;
      } catch {
        // skip failed queries
      }
    });
    await Promise.all(promises);
  }
  return results;
}
