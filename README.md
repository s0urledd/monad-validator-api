# Monad Validator & Staking API

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-6BA539?logo=openapiinitiative&logoColor=white)](openapi.json)
[![Monad](https://img.shields.io/badge/Monad-Blockchain-836EF9)](https://monad.xyz/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Validator uptime, VDP compliance and on-chain staking data for Monad, served
as read-only REST.

Uptime is read from the consensus log of our own nodes, because that is the
only place block authorship appears. None of Monad's three real-time data
sources carry the proposer, and the staking precompile reports only who is
proposing right now, with no history. Running this next to a node that
follows consensus is therefore not an implementation detail — it is what
makes the dataset possible.

Live: [validator-api.huginn.tech](https://validator-api.huginn.tech) ·
[testnet](https://validator-api-testnet.huginn.tech)

## What it holds

Raw rounds land in a 48-hour rolling window and are rolled up into permanent
per-epoch snapshots before they age out, so 30-day, 90-day and all-time figures
survive long after the events are gone. Staking precompile events are indexed
as they are emitted, since the chain keeps no queryable history of them: a
delegation or commission change not captured live is unrecoverable.

From that history the service computes VDP compliance — weekly uptime against
the 98% line and strikes inside the rolling three-month window — which is
otherwise not something an operator can check for themselves. Three strikes
report as `breach`, meaning the condition is met; whether the Foundation
removes delegation is its call and not something the API can see.

## Architecture

```mermaid
graph TD
    ML[monad-ledger-tail<br><i>consensus log</i>] -->|real-time| LG[logger.js]
    SP[Staking Precompile<br><i>0x…1000</i>] -->|epoch poll| SS[status-sync.js]
    SP -->|eth_getLogs| EI[event-indexer.js]
    GH[validator-info<br><i>GitHub</i>] -->|hourly| GS[github-sync.js]

    LG -->|rounds| DB[(SQLite<br>monad.db)]
    SS -->|status & stake| DB
    EI -->|events & rewards| DB
    GS -->|metadata| DB

    SS -->|epoch transition| SJ[snapshot-job.js]
    SJ -->|permanent snapshots| DB

    DB --> IX[index.js<br><i>Express</i>]
    ST[staking.js<br><i>live RPC, 30s cache</i>] --> IX
    VD[vdp.js] --> IX
    MT[metrics.js] --> IX

    IX --> API[REST + /metrics + docs]

    style DB fill:#003B57,stroke:#005f8a,color:#fff
    style IX fill:#2d6a2d,stroke:#3a8a3a,color:#fff
    style SJ fill:#6a3d6a,stroke:#8a5a8a,color:#fff
    style VD fill:#6a3d6a,stroke:#8a5a8a,color:#fff
    style API fill:#444,stroke:#666,color:#fff
```

## How uptime survives the window

```mermaid
graph LR
    LOGS[consensus log] --> UE[uptime_events<br><i>48h rolling</i>]
    EP[epoch transition] --> SJ[snapshot-job.js]
    UE -.->|aggregate| SJ
    SJ --> ES[uptime_epoch_snapshots<br><i>permanent</i>]

    UE -->|live| A1[24h uptime]
    ES -->|SUM across epochs| A2[30d / 90d / all-time]
    ES -->|weekly buckets| A3[VDP compliance]

    style UE fill:#8B4513,stroke:#A0522D,color:#fff
    style ES fill:#003B57,stroke:#005f8a,color:#fff
```

Events are only deleted once they have been snapshotted. If no snapshot exists,
cleanup removes nothing, so a stalled indexer costs disk rather than history.

## Endpoints

The full reference lives at `/` on a running instance, generated from
[`openapi.json`](openapi.json), where each endpoint can also be called live.
`GET /monad-api` returns the same list as JSON and `/llms.txt` renders it as
plain text for agents. All three come from the one document.

| | |
|---|---|
| `GET /monad-api/validators` | Metadata, stake, status. `?limit` `?offset` |
| `GET /monad-api/validators/stats` | Counts by status |
| `GET /monad-api/validators/{id}` | One validator, by ID or secp address |
| `GET /monad-api/validators/uptime` | All validators. `?window` or `?period`, `?sort`, `?limit` |
| `GET /monad-api/validators/uptime/{id}` | One validator |
| `GET /monad-api/validators/uptime/{id}/history` | Round by round |
| `GET /monad-api/validators/network/uptime` | Per epoch, network-wide |
| `GET /monad-api/validators/vdp` | Compliance for every validator, worst first |
| `GET /monad-api/validators/{id}/vdp` | Week by week, with the strike breakdown |
| `GET /monad-api/validators/{id}/health` | `healthy` / `degraded` / `stale` / `no_data` |
| `GET /monad-api/staking/epoch` | Current epoch and delay period |
| `GET /monad-api/staking/pool` | Bonded, staked, APR |
| `GET /monad-api/staking/validator-set` | Who enters and leaves next epoch |
| `GET /monad-api/staking/proposer` | Current block proposer |
| `GET /monad-api/staking/validator/{id}` | Live stake, commission, pending changes |
| `GET /monad-api/staking/validator/{id}/delegators` | Paginated. `?limit` `?cursor` |
| `GET /monad-api/staking/validator/{id}/rewards` | Block rewards per epoch |
| `GET /monad-api/staking/validator/{id}/events` | Indexed events for one validator |
| `GET /monad-api/staking/events` | Network-wide. `?type` `?address` `?limit` |
| `GET /monad-api/staking/delegator/{address}` | Every delegation an address holds |
| `GET /monad-api/staking/flow` | Net stake movement per validator. `?period=24h|7d|30d|all` |
| `GET /monad-api/staking/validator/{id}/flow` | Same, for one validator |
| `GET /monad-api/status` | Data freshness: newest round, last snapshot, indexer cursor |
| `GET /health` | Liveness |
| `GET /metrics` | Prometheus exposition |
| `GET /llms.txt` | Agent-readable rendering of the spec |

Uptime endpoints answer two different questions. Without `period` they read the
rolling event window (`?window=1..168` hours, default 24). With
`?period=30d|90d|all` they read the permanent snapshots, which reach back
further. Results come sorted by uptime, so adding `?limit` gives a leaderboard.

## Decisions worth knowing

**Two APR figures, not one.** `/staking/pool` publishes `estimated_apr` from
the block time the documentation implies and `calculated_apr` from the block
time measured across recent epochs, alongside every input. A hardcoded block
time is the classic way to be quietly wrong about yield: the constant this
service previously used was correct until a hardfork shortened epochs from
5.5h to 4h12m, after which it would have been off by a third. The measured
figure tracked the change on its own.

**Weekly uptime is summed, not averaged.** A week's rate is
`Σ finalized / Σ total` across its epochs. Averaging the per-epoch percentages
instead would let a quiet epoch outweigh a busy one.

**Absence is not a clean record.** A validator that leaves the active set stops
producing rounds, so its weeks go missing rather than bad. Compliance therefore
counts the weeks the window should hold against the weeks actually observed;
any shortfall reports as `insufficient_data` rather than as no strikes. Silence
must not score better than staying up and occasionally missing.

**Only completed weeks can be strikes.** A validator two hours into a bad
Monday has not breached anything yet.

**VDP is scoped to mainnet.** The weekly maths runs anywhere, but a strike on
testnet carries no consequence, so those series are withheld from `/metrics`
there and the endpoints report `applies: false`. The distinction comes from
`NETWORK`, since both networks run this same code.

**Delegator lists are paginated against the precompile's own cursor.** Walking
the whole set turns one HTTP request into an unbounded number of RPC calls,
which the staking documentation explicitly warns against.

**The event indexer finds out what the node still has.** A node that is not
an archive node serves logs for a window of recent blocks, and the size of
that window depends on its disk, not on the chain. On our mainnet node it is
about 950,000 blocks, roughly 79 hours. If the service falls behind that
window, the first `eth_getLogs` on the oldest missing chunk fails, and an
indexer that simply retries sits on the same block forever while reporting a
valid cursor.

When a chunk fails, the indexer probes the failing block and a recent one. If
only the old one fails, it binary searches for the oldest block the node still
serves, about twenty calls, records the skipped range under
`event_indexer.gaps` in `/monad-api/status`, and resumes
`EVENT_INDEXER_EDGE_MARGIN` blocks above that edge. If the recent block fails
too, the node is unwell rather than pruned, and the cursor stays put. None of
this reads the error text, which differs between clients, and there is no
retention size to configure, so it behaves the same on any node. On an archive
node it never triggers.

`/monad-api/status` also carries `last_success_utc`, `stalled` and
`last_error`, so a stuck indexer shows as stuck rather than as a number that
happens not to change.

## Setup

```bash
git clone <repo> monad-api && cd monad-api
npm install
cp .env.example .env      # edit
npm run sync              # first metadata pull
npm start
```

Two processes share one SQLite database in WAL mode:

| | |
|---|---|
| `npm start` | API, metadata sync, epoch watcher, snapshot indexer, event indexer |
| `npm run logger` | `journalctl` → `uptime_events` |

`npm run index-events` runs a single indexer pass; `npm run status-sync` and
`npm run sync` do the same for staking data and metadata.

### Systemd

```
monad-api.service            → node index.js
monad-uptime-logger.service  → node logger.js
```

Units are in `services.txt`.

```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now monad-api monad-uptime-logger
journalctl -u monad-api -f
```

### Behind a reverse proxy

`TRUST_PROXY` defaults to `loopback`, which is correct for nginx on the same
host: without it every request appears to come from `127.0.0.1` and the per-IP
rate limiter becomes one shared bucket. It is deliberately not `true`, which
would accept any `X-Forwarded-For` a client sends and let anyone forge an
address past the limit.

One `location /` is enough — it covers the API, the docs, `/health` and
`/metrics`.

## Environment

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | `127.0.0.1` when behind a proxy |
| `NETWORK` | `testnet` | Set it explicitly — see below |
| `MONAD_RPC_URL` | `http://127.0.0.1:8080` | |
| `JOURNAL_UNIT` | `monad-ledger-tail` | Unit the logger tails |
| `TRUST_PROXY` | `loopback` | Hops trusted for `X-Forwarded-For` |
| `METADATA_SYNC_INTERVAL_MS` | `3600000` | |
| `STATUS_SYNC_INTERVAL_MS` | `3600000` | |
| `EPOCH_POLL_MS` | `120000` | Epoch watcher |
| `UPTIME_RETENTION_HOURS` | `48` | Rolling window for raw rounds |
| `EVENT_INDEXER_POLL_MS` | `30000` | |
| `EVENT_INDEXER_CHUNK` | `1000` | Blocks per `eth_getLogs` |
| `EVENT_INDEXER_CONFIRMATIONS` | `10` | Blocks to stay behind the head |
| `EVENT_INDEXER_START_BLOCK` | — | Backfill from here on first run |
| `EVENT_INDEXER_EDGE_MARGIN` | `10000` | Blocks above the node's retention edge to resume from after a skip |
| `LOG_LEVEL` | `info` | |

`NETWORK` decides three things: which directory metadata is pulled from,
whether VDP applies, and the label on `monad_build_info`. Left unset it falls
back to `testnet` for metadata but reports `unknown` in metrics and disables
VDP, so a mainnet deployment that forgets it loses the compliance series
without any error. Set it.

## Storage

`validators` holds metadata and synced on-chain staking data.
`uptime_events` is the rolling window of raw rounds.
`uptime_epoch_snapshots` is the permanent record, one row per validator per
epoch, and the basis of every cumulative and compliance figure.

`ValidatorRewarded` fires once per block, so it is rolled up per validator per
epoch in `validator_rewards_epoch` rather than stored raw — roughly 68 MB a
year instead of 16 GB. The other eight events go into `staking_events`, keyed
on `(block_number, log_index)`. Its row shape is deliberately loose, so a new
event type means a new enum value rather than a new table.

Writes and the indexer cursor advance in the same transaction. Rewards
accumulate by read-modify-write, so a replayed range would otherwise double
count; a crash rolls back both and the range is retried from a clean state.

## Metrics

`/metrics` exposes the dataset in Prometheus text format — per-validator
uptime, stake, commission and VDP strikes, plus network totals, indexer
progress and the measured block time. Every value is read from SQLite; nothing
in `metrics.js` touches the RPC, so a scrape cannot stall behind the node.

```yaml
scrape_configs:
  - job_name: monad-validator-api
    scrape_interval: 30s
    scheme: https
    static_configs:
      - targets: ['validator-api.huginn.tech:443']
        labels: { network: mainnet }
      - targets: ['validator-api-testnet.huginn.tech:443']
        labels: { network: testnet }
```

Validator IDs start at 1 on both networks and mean different validators, so
`monad_build_info` carries the network as a label.

## Notes

Monetary values are returned as numbers, not formatted strings. Live RPC calls
share a 30-second in-memory cache. Staking routes allow 60 requests per minute
per IP and return `X-RateLimit-*` headers; validator routes are unmetered. A
failed GitHub sync leaves existing metadata untouched.

## License

[MIT](LICENSE).
