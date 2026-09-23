// src/event-indexer.js - Index staking precompile events into SQLite
import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import {
  getIndexerCursor,
  setIndexerCursor,
  commitIndexedRange,
  getIndexerStats,
  markIndexerSuccess,
  markIndexerError,
  recordIndexerGap,
} from "./db.js";

const MONAD_RPC_URL = process.env.MONAD_RPC_URL || "http://127.0.0.1:8080";
const STAKING_ADDRESS = "0x0000000000000000000000000000000000001000";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const POLL_MS = Number(process.env.EVENT_INDEXER_POLL_MS || 30000);

// Blocks per getLogs call. At ~0.3s per block a 30s poll only advances ~100
// blocks, so this ceiling matters mainly when catching up after downtime.
const CHUNK_SIZE = Number(process.env.EVENT_INDEXER_CHUNK || 1000);

// Stay this far behind the head so a reorg near the tip doesn't strand us with
// events that never made it into the canonical chain.
const CONFIRMATIONS = Number(process.env.EVENT_INDEXER_CONFIRMATIONS || 10);

// A node that is not an archive node only serves logs for a window of recent
// blocks, and the size of that window depends on the node's disk and
// configuration, not on anything the chain defines. If the cursor falls behind
// the window (the API was down, the node was resyncing), every getLogs on the
// oldest chunk fails, and an indexer that simply retries stays stuck forever.
//
// When a chunk fails, the indexer therefore asks the node what it can serve
// instead of guessing: it probes the failing block and a recent one, and if
// only the old one fails it binary searches for the oldest block the node
// still has. The skipped range is recorded as a gap and indexing resumes this
// many blocks above the edge, since the node keeps pruning while we read.
// Nothing here depends on the error text, which differs between clients.
const EDGE_MARGIN_BLOCKS = Number(process.env.EVENT_INDEXER_EDGE_MARGIN || 10000);

// Optional override to backfill from a specific block on first run.
const START_BLOCK = process.env.EVENT_INDEXER_START_BLOCK
  ? Number(process.env.EVENT_INDEXER_START_BLOCK)
  : null;

const CURSOR_KEY = "staking_events_last_block";

// Signatures copied from the staking API reference.
const EVENT_ABI = [
  "event ValidatorRewarded(uint64 indexed validatorId, address indexed from, uint256 amount, uint64 epoch)",
  "event ValidatorCreated(uint64 indexed validatorId, address indexed authAddress, uint256 commission)",
  "event ValidatorStatusChanged(uint64 indexed validatorId, uint64 flags)",
  "event Delegate(uint64 indexed validatorId, address indexed delegator, uint256 amount, uint64 activationEpoch)",
  "event Undelegate(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 activationEpoch)",
  "event Withdraw(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 withdrawEpoch)",
  "event ClaimRewards(uint64 indexed validatorId, address indexed delegator, uint256 amount, uint64 epoch)",
  "event CommissionChanged(uint64 indexed validatorId, uint256 oldCommission, uint256 newCommission)",
  "event EpochChanged(uint64 oldEpoch, uint64 newEpoch)",
];

const iface = new ethers.Interface(EVENT_ABI);

// ---------- Logging ----------
const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, ...args) {
  const current = logLevels[LOG_LEVEL] ?? 2;
  if ((logLevels[level] ?? 2) <= current) {
    const prefix = { error: "❌", warn: "⚠️", info: "ℹ️", debug: "🔍" }[level] || "";
    console.log("[event-indexer]", prefix, ...args);
  }
}

// ---------- Decoding ----------

/**
 * Turn a decoded log into a row for staking_events, or null for the events we
 * do not store raw.
 *
 * The shape is deliberately generic — validator_id / address / amount_wei /
 * epoch cover most events, and anything event-specific goes into `extra` — so
 * that adding an event later does not mean a new table or a new endpoint.
 */
function toEventRow(parsed, logEntry, blockTs) {
  const name = parsed.name;
  const a = parsed.args;

  const base = {
    blockNumber: logEntry.blockNumber,
    logIndex: logEntry.index,
    txHash: logEntry.transactionHash || null,
    eventType: name,
    validatorId: null,
    address: null,
    amountWei: null,
    epoch: null,
    extra: null,
    blockTs: blockTs ?? null,
  };

  switch (name) {
    case "Delegate":
      return {
        ...base,
        validatorId: Number(a.validatorId),
        address: a.delegator.toLowerCase(),
        amountWei: a.amount.toString(),
        epoch: Number(a.activationEpoch),
      };

    case "Undelegate":
      return {
        ...base,
        validatorId: Number(a.validatorId),
        address: a.delegator.toLowerCase(),
        amountWei: a.amount.toString(),
        epoch: Number(a.activationEpoch),
        extra: JSON.stringify({ withdraw_id: Number(a.withdrawId) }),
      };

    case "Withdraw":
      return {
        ...base,
        validatorId: Number(a.validatorId),
        address: a.delegator.toLowerCase(),
        amountWei: a.amount.toString(),
        epoch: Number(a.withdrawEpoch),
        extra: JSON.stringify({ withdraw_id: Number(a.withdrawId) }),
      };

    case "ClaimRewards":
      return {
        ...base,
        validatorId: Number(a.validatorId),
        address: a.delegator.toLowerCase(),
        amountWei: a.amount.toString(),
        epoch: Number(a.epoch),
      };

    case "CommissionChanged":
      return {
        ...base,
        validatorId: Number(a.validatorId),
        extra: JSON.stringify({
          old_commission: a.oldCommission.toString(),
          new_commission: a.newCommission.toString(),
        }),
      };

    case "ValidatorCreated":
      return {
        ...base,
        validatorId: Number(a.validatorId),
        address: a.authAddress.toLowerCase(),
        extra: JSON.stringify({ commission: a.commission.toString() }),
      };

    case "ValidatorStatusChanged":
      return {
        ...base,
        validatorId: Number(a.validatorId),
        extra: JSON.stringify({ flags: a.flags.toString() }),
      };

    case "EpochChanged":
      return {
        ...base,
        epoch: Number(a.newEpoch),
        extra: JSON.stringify({ old_epoch: Number(a.oldEpoch) }),
      };

    // Fires once per block; rolled up into validator_rewards_epoch instead.
    case "ValidatorRewarded":
      return null;

    default:
      return null;
  }
}

// ---------- Indexing ----------

async function fetchBlockTimestamps(provider, blockNumbers) {
  const timestamps = new Map();
  // Only the sparse events get a timestamp, so this stays a handful of calls.
  await Promise.all(
    [...blockNumbers].map(async (bn) => {
      try {
        const block = await provider.getBlock(bn);
        if (block) timestamps.set(bn, block.timestamp);
      } catch (err) {
        log("debug", `Failed to fetch block ${bn}: ${err.message}`);
      }
    })
  );
  return timestamps;
}

async function indexRange(provider, fromBlock, toBlock) {
  const logs = await provider.getLogs({
    address: STAKING_ADDRESS,
    fromBlock,
    toBlock,
  });

  const decoded = [];
  const rewardMap = new Map();

  for (const logEntry of logs) {
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...logEntry.topics], data: logEntry.data });
    } catch {
      continue; // event not in our ABI
    }
    if (!parsed) continue;

    if (parsed.name === "ValidatorRewarded") {
      const validatorId = Number(parsed.args.validatorId);
      const epoch = Number(parsed.args.epoch);
      const key = `${validatorId}:${epoch}`;
      const entry = rewardMap.get(key);
      if (entry) {
        entry.amountWei += parsed.args.amount;
        entry.count += 1;
        entry.lastBlock = Math.max(entry.lastBlock, logEntry.blockNumber);
        entry.firstBlock = Math.min(entry.firstBlock, logEntry.blockNumber);
      } else {
        rewardMap.set(key, {
          validatorId,
          epoch,
          amountWei: parsed.args.amount,
          count: 1,
          firstBlock: logEntry.blockNumber,
          lastBlock: logEntry.blockNumber,
        });
      }
      continue;
    }

    decoded.push({ parsed, logEntry });
  }

  const blockNumbers = new Set(decoded.map((d) => d.logEntry.blockNumber));
  const timestamps = blockNumbers.size
    ? await fetchBlockTimestamps(provider, blockNumbers)
    : new Map();

  const rows = [];
  for (const { parsed, logEntry } of decoded) {
    const row = toEventRow(parsed, logEntry, timestamps.get(logEntry.blockNumber));
    if (row) rows.push(row);
  }

  const rewards = [...rewardMap.values()];

  // Writes and cursor advance together, so a crash cannot double count rewards.
  commitIndexedRange(rows, rewards, CURSOR_KEY, toBlock);

  return { logs: logs.length, stored: rows.length, rewardRows: rewards.length };
}

// ---------- Retention edge ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether the node serves logs for one block. A failure is retried once after
 * a pause, so a single dropped request is not mistaken for missing history.
 * The pause also matters mechanically: ethers answers an identical request
 * from cache for 250ms, so an immediate retry would never reach the node.
 */
async function logsServable(provider, block) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1000);
    try {
      await provider.getLogs({ address: STAKING_ADDRESS, fromBlock: block, toBlock: block });
      return true;
    } catch {
      // fall through to the retry
    }
  }
  return false;
}

/**
 * The oldest block in [from, recent] the node still serves logs for, or null
 * when the failure is not about retention: either `from` itself is served, or
 * `recent` is not, which means the node is unwell rather than pruned.
 *
 * About twenty single-block calls for a window of a million blocks. The node
 * could report this in its error instead; until it does, we ask.
 */
async function findRetentionEdge(provider, from, recent) {
  if (await logsServable(provider, from)) return null;
  if (!(await logsServable(provider, recent))) return null;

  let lo = from; // not servable
  let hi = recent; // servable
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await logsServable(provider, mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

async function runOnce(provider) {
  const head = await provider.getBlockNumber();
  const safeHead = head - CONFIRMATIONS;

  let cursor = getIndexerCursor(CURSOR_KEY);
  if (cursor === null) {
    const start = START_BLOCK ?? safeHead;
    setIndexerCursor(CURSOR_KEY, start);
    cursor = String(start);
    log("info", `No cursor found, starting from block ${start}`);
  }

  let from = Number(cursor) + 1;
  if (from > safeHead) {
    log("debug", `Nothing to do (cursor ${cursor}, safe head ${safeHead})`);
    return;
  }

  let totals = { logs: 0, stored: 0, rewardRows: 0, blocks: 0 };
  let skipped = false;

  while (from <= safeHead) {
    const to = Math.min(from + CHUNK_SIZE - 1, safeHead);

    let result;
    try {
      result = await indexRange(provider, from, to);
    } catch (err) {
      // Skip at most once per run, so a node that keeps failing surfaces as an
      // error on /status instead of a trail of gaps.
      if (skipped) throw err;

      const edge = await findRetentionEdge(provider, from, safeHead);
      // null: the old block is still served, or recent blocks are not either.
      // Either way this is the node having a bad moment, not history running
      // out, so leave the cursor alone and let the next tick retry.
      if (edge === null) throw err;

      const resume = Math.min(edge + EDGE_MARGIN_BLOCKS, safeHead);
      recordIndexerGap(from, resume - 1);
      setIndexerCursor(CURSOR_KEY, resume - 1);
      log(
        "warn",
        `Chunk ${from}-${to} failed (${describeError(err)}). The node's oldest block ` +
          `with logs is ${edge}, so blocks ${from}-${resume - 1} are no longer ` +
          `available and will not be indexed. Resuming at ${resume}.`
      );
      skipped = true;
      from = resume;
      continue;
    }

    totals.logs += result.logs;
    totals.stored += result.stored;
    totals.rewardRows += result.rewardRows;
    totals.blocks += to - from + 1;

    from = to + 1;
  }

  if (totals.logs > 0) {
    log(
      "info",
      `Indexed ${totals.blocks} blocks up to ${safeHead}: ${totals.logs} logs, ` +
        `${totals.stored} stored, ${totals.rewardRows} reward rows touched`
    );
  } else {
    log("debug", `Indexed ${totals.blocks} blocks up to ${safeHead}, no events`);
  }
}

// ethers wraps a JSON-RPC failure in a message that repeats the whole request
// payload. The node's own message is the useful part.
function describeError(err) {
  return err?.error?.message || err?.shortMessage || err?.message || String(err);
}

// ---------- Scheduling ----------
let _interval = null;
let _running = false;

async function tick() {
  if (_running) {
    log("debug", "Previous run still in progress, skipping tick");
    return;
  }
  _running = true;

  let provider;
  try {
    provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
    await runOnce(provider);
    markIndexerSuccess();
  } catch (err) {
    const message = describeError(err);
    log("error", "Indexing failed:", message);
    markIndexerError(message);
  } finally {
    if (provider) provider.destroy();
    _running = false;
  }
}

export function startEventIndexer() {
  const stats = getIndexerStats();
  const cursor = getIndexerCursor(CURSOR_KEY);
  log(
    "info",
    `Starting event indexer (cursor: ${cursor ?? "none"}, ` +
      `${stats.events} events, ${stats.reward_rows} reward rows)`
  );

  tick();
  _interval = setInterval(tick, POLL_MS);
  log(
    "info",
    `Polling every ${POLL_MS / 1000}s, ${CONFIRMATIONS} block confirmations, ` +
      `${EDGE_MARGIN_BLOCKS} block margin above the node's retention edge`
  );
}

export function stopEventIndexer() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

// ---------- CLI Mode ----------
const isMain = process.argv[1]?.includes("event-indexer");
if (isMain) {
  const provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
  runOnce(provider)
    .then(() => {
      console.log("\n✅ Indexer run complete:", getIndexerStats());
      provider.destroy();
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Indexer run failed:", err);
      process.exit(1);
    });
}

export { runOnce, findRetentionEdge };
