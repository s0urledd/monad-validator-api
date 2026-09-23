// backfill-events.js - Rebuild staking history from an archive RPC
//
// The live indexer reads forward from the block it was started at, and our
// node only keeps a few days of logs. Everything older, plus any range the
// live indexer had to skip, has to come from an archive node.
//
// Work is done one completed epoch at a time, and each epoch's reward rows
// are replaced in a single transaction. Running the backfill twice therefore
// gives the same result as running it once, and stopping it halfway loses
// nothing. Events are keyed by (block, log index) and inserted idempotently.
//
// Epoch boundaries come from the data, not from arithmetic. An epoch is about
// 50,000 blocks, but the new epoch starts after a delay counted in rounds, and
// a round that times out produces no block, so the boundary drifts. Blocks
// are read in order and an epoch is closed at the first block reward tagged
// with the next one.
//
// Every block pays exactly one block reward. An epoch is only stored if every
// block in its span has one and every reward in it carries its epoch number.
//
// Usage:
//   node backfill-events.js [--rpc URL] [--from-epoch N] [--concurrency N] [--all]
//     rebuilds every completed epoch that is missing or incomplete; --all
//     rebuilds them regardless, --from-epoch sets the lowest one
//   node backfill-events.js --verify

import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import { rpcGetLogs, aggregateLogs, eventRows, BLOCK_REWARD_SENDER } from "./event-indexer.js";
import {
  getIndexerCursor,
  setIndexerCursor,
  getIndexerGaps,
  clearIndexerGap,
  replaceEpochRewards,
  getBlocksPerEpoch,
} from "./db.js";

const STAKING_ADDRESS = "0x0000000000000000000000000000000000001000";
const REWARD_TOPIC = ethers.id("ValidatorRewarded(uint64,address,uint256,uint64)");
const SENDER_TOPIC = ethers.zeroPadValue(BLOCK_REWARD_SENDER, 32);
const LIVE_CURSOR_KEY = "staking_events_last_block";
const ANCHOR_KEY = "staking_rewards_anchor";
const PROGRESS_KEY = "staking_rewards_rebuilt_epoch";

// ---------- Arguments ----------
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const RPC_URL = arg("rpc", process.env.ARCHIVE_RPC_URL || "https://rpc1.monad.xyz");
const CHUNK = Number(arg("chunk", 5000));
const CONCURRENCY = Number(arg("concurrency", 2));
const FROM_EPOCH = arg("from-epoch", null);
const VERIFY_ONLY = args.includes("--verify");
const FORCE = args.includes("--all");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + Number(n).toString(16);

// Public endpoints occasionally answer with an HTML error page or drop the
// connection under load, so transport failures are retried with backoff. A
// JSON-RPC error is an answer, not a transport failure, and is thrown as is.
async function rpc(url, method, params) {
  for (let attempt = 1; ; attempt++) {
    let body;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(60000),
      });
      body = JSON.parse(await res.text());
    } catch (err) {
      if (attempt >= 6) throw new Error(`${method} on ${url}: ${err.message}`);
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
}

const isBlockReward = (l) => l.topics[0] === REWARD_TOPIC && l.topics[2]?.toLowerCase() === SENDER_TOPIC;
const rewardEpoch = (l) => Number(BigInt("0x" + l.data.slice(66, 130)));

// ---------- Epoch boundaries ----------

/** The epoch of the block reward paid in block b, or null if none. */
async function epochAt(b) {
  const logs = await rpc(RPC_URL, "eth_getLogs", [
    { fromBlock: hex(b), toBlock: hex(b), address: STAKING_ADDRESS, topics: [REWARD_TOPIC, null, SENDER_TOPIC] },
  ]);
  return logs.length ? rewardEpoch(logs[0]) : null;
}

/** Smallest block in (lo, hi] for which pred holds, given pred(hi) and not
 *  pred(lo), and pred monotonic in between. */
async function firstBlockWhere(lo, hi, pred) {
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await pred(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The first block that paid a block reward, and its epoch. Once rewards
 * start, every block has one, so a binary search finds the start. Stored
 * after the first run.
 */
async function loadAnchor(head) {
  const stored = getIndexerCursor(ANCHOR_KEY);
  if (stored) return JSON.parse(stored);

  if ((await epochAt(head)) === null) throw new Error(`No block reward at ${head} on ${RPC_URL}`);
  const block = await firstBlockWhere(0, head, async (b) => (await epochAt(b)) !== null);
  const anchor = { block, epoch: await epochAt(block) };
  setIndexerCursor(ANCHOR_KEY, JSON.stringify(anchor));
  return anchor;
}

/** First block of an epoch: the first block whose reward is tagged >= epoch. */
async function epochStartBlock(anchor, head, epoch) {
  if (epoch <= anchor.epoch) return anchor.block;
  return firstBlockWhere(anchor.block, head, async (b) => (await epochAt(b)) >= epoch);
}

// ---------- Fetching ----------

async function fetchRange(from, to) {
  // Public archives cap the response size, and a busy stretch can exceed it
  // at a range that is fine elsewhere, so halve on that error. Anything else
  // is retried with backoff.
  const logs = [];
  let start = from;
  let size = CHUNK;
  let attempt = 0;
  while (start <= to) {
    const end = Math.min(start + size - 1, to);
    try {
      logs.push(...(await rpcGetLogs(RPC_URL, start, end)));
      start = end + 1;
      size = CHUNK;
      attempt = 0;
    } catch (err) {
      if (/size exceeded|too large|limited to|range/i.test(err.message) && size > 100) {
        size = Math.floor(size / 2);
        continue;
      }
      if (++attempt >= 6) throw new Error(`Blocks ${start}-${end}: ${err.message}`);
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  return logs;
}

/** CONCURRENCY consecutive chunks fetched side by side, returned in order. */
async function fetchWindow(from, to) {
  const parts = [];
  for (let a = from; a <= to && parts.length < CONCURRENCY; a += CHUNK) {
    parts.push(fetchRange(a, Math.min(a + CHUNK - 1, to)));
  }
  return (await Promise.all(parts)).flat();
}

// ---------- Rebuild ----------

async function storeEpoch(provider, epoch, first, last, logs) {
  const { decoded, rewards } = aggregateLogs(logs);

  const wrong = rewards.find((r) => r.epoch !== epoch);
  if (wrong) throw new Error(`Blocks ${first}-${last} carry rewards for epoch ${wrong.epoch}, expected ${epoch}.`);
  const blocks = rewards.reduce((s, r) => s + r.blockCount, 0);
  if (blocks !== last - first + 1) {
    throw new Error(`Epoch ${epoch} (${first}-${last}) has ${blocks} block rewards for ${last - first + 1} blocks. Not stored.`);
  }

  const events = await eventRows(provider, decoded);
  replaceEpochRewards(epoch, events, rewards, PROGRESS_KEY);
  return { events: events.length, external: rewards.reduce((s, r) => s + r.externalCount, 0) };
}

/**
 * Rebuild the consecutive epochs fromEpoch..toEpoch. Blocks are read in order
 * and split at each block reward that starts a new epoch.
 */
async function rebuildRun(provider, anchor, head, fromEpoch, toEpoch, progress) {
  const start = await epochStartBlock(anchor, head, fromEpoch);
  const end = (await epochStartBlock(anchor, head, toEpoch + 1)) - 1;

  let epoch = fromEpoch;
  let epochFirst = start;
  let buffer = [];

  const flushUpTo = async (lastBlock) => {
    const logs = buffer.filter((l) => l.blockNumber <= lastBlock);
    buffer = buffer.filter((l) => l.blockNumber > lastBlock);
    const r = await storeEpoch(provider, epoch, epochFirst, lastBlock, logs);
    progress(epoch, epochFirst, lastBlock, r);
  };

  for (let from = start; from <= end; from += CHUNK * CONCURRENCY) {
    const to = Math.min(from + CHUNK * CONCURRENCY - 1, end);
    buffer.push(...(await fetchWindow(from, to)));

    for (;;) {
      const next = buffer.find((l) => isBlockReward(l) && rewardEpoch(l) > epoch);
      if (!next) break;
      if (rewardEpoch(next) !== epoch + 1) {
        throw new Error(`Block ${next.blockNumber} jumps from epoch ${epoch} to ${rewardEpoch(next)}.`);
      }
      await flushUpTo(next.blockNumber - 1);
      epoch += 1;
      epochFirst = next.blockNumber;
    }
  }

  if (epoch !== toEpoch) throw new Error(`Reached block ${end} in epoch ${epoch}, expected ${toEpoch}.`);
  await flushUpTo(end);
}

// ---------- Verify ----------

/**
 * Which epochs are complete. An epoch is complete when its block/external
 * split is known, every block in its span has one block reward, and it starts
 * right after the previous epoch ends. The last check is what catches an
 * epoch that is only partly indexed but contiguous within itself.
 */
function completeness(fromEpoch, toEpoch, anchor) {
  const byEpoch = new Map(getBlocksPerEpoch().map((e) => [e.epoch, e]));
  const result = new Map();
  for (let ep = fromEpoch; ep <= toEpoch; ep++) {
    const e = byEpoch.get(ep);
    const prev = byEpoch.get(ep - 1);
    let state = "complete";
    if (!e) state = "missing";
    else if (e.blocks === null) state = "not split";
    else if (e.blocks !== e.last_block - e.first_block + 1) state = "holes";
    else if (ep === anchor?.epoch ? e.first_block !== anchor.block : !prev || prev.last_block + 1 !== e.first_block) {
      state = "start unconfirmed";
    }
    result.set(ep, { state, ...e });
  }
  return result;
}

function report(states, fromEpoch, toEpoch) {
  const by = {};
  let blocks = 0;
  for (const [ep, s] of states) {
    (by[s.state] ||= []).push(ep);
    if (s.state === "complete") blocks += s.blocks;
  }
  console.log(`\nEpochs ${fromEpoch}-${toEpoch}:`);
  console.log(`  ${(by.complete || []).length} complete, ${blocks} blocks with a recorded proposer`);
  const fmt = (xs) => (xs.length > 12 ? `${xs.slice(0, 12).join(", ")} ... (${xs.length})` : xs.join(", "));
  for (const [state, eps] of Object.entries(by)) if (state !== "complete") console.log(`  ${state}: ${fmt(eps)}`);
  return Object.keys(by).every((s) => s === "complete");
}

// ---------- Main ----------

async function assertSameChain() {
  const archiveId = parseInt(await rpc(RPC_URL, "eth_chainId", []), 16);
  const localUrl = process.env.MONAD_RPC_URL || "http://127.0.0.1:8080";
  let localId;
  try {
    localId = parseInt(await rpc(localUrl, "eth_chainId", []), 16);
  } catch (err) {
    console.log(`Could not reach ${localUrl} to confirm the network (${err.message}); continuing.`);
    return archiveId;
  }
  if (localId !== archiveId) {
    throw new Error(`Archive RPC is chain ${archiveId} but ${localUrl} is chain ${localId}. Pass --rpc for this network.`);
  }
  return archiveId;
}

async function main() {
  const liveCursor = getIndexerCursor(LIVE_CURSOR_KEY);
  if (liveCursor === null) throw new Error("The live indexer has no cursor yet. Start the API first.");

  if (VERIFY_ONLY) {
    const anchor = JSON.parse(getIndexerCursor(ANCHOR_KEY) || "null");
    const epochs = getBlocksPerEpoch();
    if (!epochs.length) return console.log("No reward rows.");
    // Without the archive we can't place the live cursor in an epoch, so
    // treat the newest stored epoch as the one still filling.
    const from = anchor?.epoch ?? epochs[0].epoch;
    const to = epochs[epochs.length - 1].epoch - 1;
    process.exit(report(completeness(from, to, anchor), from, to) ? 0 : 1);
  }

  const chainId = await assertSameChain();
  const head = parseInt(await rpc(RPC_URL, "eth_blockNumber", []), 16) - 100;
  const anchor = await loadAnchor(head);
  console.log(`Archive ${RPC_URL} (chain ${chainId}). Block rewards start at block ${anchor.block}, epoch ${anchor.epoch}.`);

  // Only epochs the live indexer has moved past: it keeps writing the one it
  // is in, and the two must never touch the same epoch.
  const liveEpoch = await epochAt(Number(liveCursor));
  if (liveEpoch === null) throw new Error(`No block reward at the live cursor ${liveCursor}.`);
  const lastEpoch = liveEpoch - 1;
  const lowest = FROM_EPOCH !== null ? Number(FROM_EPOCH) : anchor.epoch;

  // Rebuild what is not complete, so a plain rerun picks up exactly what is
  // left whatever was run before.
  const states = completeness(lowest, lastEpoch, anchor);
  const todo = [...states].filter(([, s]) => FORCE || s.state !== "complete").map(([ep]) => ep);

  // An epoch whose start could not be confirmed only because its predecessor
  // is being rebuilt will be confirmed by that rebuild; rebuilding it too is
  // harmless and keeps the logic simple.
  const runs = [];
  for (const ep of todo) {
    const run = runs[runs.length - 1];
    if (run && run[1] === ep - 1) run[1] = ep;
    else runs.push([ep, ep]);
  }

  if (!todo.length) {
    console.log(`Nothing to rebuild: epochs ${lowest}-${lastEpoch} are complete, and ${liveEpoch} is still live.`);
  } else {
    console.log(`Rebuilding ${todo.length} epochs in ${runs.length} run(s), ${CONCURRENCY} requests at a time.`);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  const started = Date.now();
  let done = 0;
  const progress = (epoch, first, last, r) => {
    done += 1;
    const left = Math.ceil((((Date.now() - started) / done) * (todo.length - done)) / 60000);
    console.log(
      `epoch ${epoch}  blocks ${first}-${last} (${last - first + 1})  ${r.events} events` +
        (r.external ? `  ${r.external} external rewards` : "") +
        `  ${done}/${todo.length}, ~${left} min left`
    );
  };
  try {
    for (const [a, b] of runs) await rebuildRun(provider, anchor, head, a, b, progress);
  } finally {
    provider.destroy();
  }

  const after = completeness(lowest, lastEpoch, anchor);

  // A gap is filled once the complete epochs cover every block in it.
  const complete = [...after.values()].filter((s) => s.state === "complete");
  for (const g of getIndexerGaps()) {
    const covering = complete.filter((s) => s.last_block >= g.from_block && s.first_block <= g.to_block);
    const covered =
      covering.length &&
      Math.min(...covering.map((s) => s.first_block)) <= g.from_block &&
      Math.max(...covering.map((s) => s.last_block)) >= g.to_block &&
      covering.length === new Set(covering.map((s) => s.epoch)).size &&
      covering.every((s, i, xs) => i === 0 || xs[i - 1].last_block + 1 === s.first_block);
    if (covered) {
      clearIndexerGap(g.from_block, g.to_block);
      console.log(`Gap ${g.from_block}-${g.to_block} filled.`);
    }
  }

  report(after, lowest, lastEpoch);
}

main().catch((err) => {
  console.error("❌ Backfill stopped:", err.message);
  console.error("Run the same command again to resume.");
  process.exit(1);
});
