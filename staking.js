// src/staking.js - Live staking precompile query service
import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";

const MONAD_RPC_URL = process.env.MONAD_RPC_URL || "http://127.0.0.1:8080";
const STAKING_ADDRESS = "0x0000000000000000000000000000000000001000";

const STAKING_ABI = [
  // Validator info
  "function getValidator(uint64 valId) external returns (tuple(address auth_address, uint256 flags, uint256 stake, uint256 acc_reward_per_token, uint256 commission, uint256 unclaimed_rewards, uint256 consensus_stake, uint256 consensus_commission, uint256 snapshot_stake, uint256 snapshot_commission, bytes secp_pubkey, bytes bls_pubkey))",
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
];

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

export async function getValidatorOnChain(valId) {
  const contract = getContract();
  const info = await contract.getValidator.staticCall(valId);
  return {
    stake: ethers.formatEther(info.stake),
    stake_wei: info.stake.toString(),
    commission: Number(info.commission) / 100,
    commission_raw: info.commission.toString(),
    unclaimed_rewards: ethers.formatEther(info.unclaimed_rewards),
    unclaimed_rewards_wei: info.unclaimed_rewards.toString(),
    acc_reward_per_token: info.acc_reward_per_token.toString(),
    consensus_stake: ethers.formatEther(info.consensus_stake),
    consensus_commission: Number(info.consensus_commission) / 100,
    snapshot_stake: ethers.formatEther(info.snapshot_stake),
    snapshot_commission: Number(info.snapshot_commission) / 100,
    auth_address: info.auth_address,
  };
}

// ---------- Delegator Queries ----------

export async function getDelegatorInfo(valId, delegatorAddress) {
  const contract = getContract();
  const result = await contract.getDelegator.staticCall(valId, delegatorAddress);
  return {
    stake: ethers.formatEther(result[0]),
    stake_wei: result[0].toString(),
    acc_reward_per_token: result[1].toString(),
    unclaimed_rewards: ethers.formatEther(result[2]),
    unclaimed_rewards_wei: result[2].toString(),
    delta_stake: result[3].toString(),
    next_delta_stake: result[4].toString(),
    delta_epoch: Number(result[5]),
    next_delta_epoch: Number(result[6]),
  };
}

export async function getAllDelegations(delegatorAddress) {
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
}

export async function getAllDelegators(valId) {
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
}

// ---------- Withdrawal Queries ----------

export async function getWithdrawalRequest(valId, delegatorAddress, withdrawId) {
  const contract = getContract();
  const result = await contract.getWithdrawalRequest.staticCall(valId, delegatorAddress, withdrawId);
  return {
    amount: ethers.formatEther(result[0]),
    amount_wei: result[0].toString(),
    acc_reward_per_token: result[1].toString(),
    withdraw_epoch: Number(result[2]),
  };
}

// ---------- Epoch & Proposer ----------

export async function getEpochInfo() {
  const contract = getContract();
  const result = await contract.getEpoch.staticCall();
  return {
    epoch: Number(result[0]),
    in_delay_period: result[1],
  };
}

export async function getProposer() {
  const contract = getContract();
  const valId = await contract.getProposerValId.staticCall();
  return Number(valId);
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
