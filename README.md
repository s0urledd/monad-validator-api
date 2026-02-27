# Monad Validator API

Validator metadata, uptime tracking, and on-chain staking data API for Monad.

## Features

- **Validator Metadata** — Auto-synced from GitHub (hourly)
- **Uptime Tracking** — Real-time log analysis (finalized/timeout rounds)
- **On-Chain Staking** — Live queries to the staking precompile (`0x...1000`)
- **Delegation Data** — Per-validator delegator lists, per-address delegation summaries
- **Epoch Awareness** — Auto-syncs on epoch transitions and boundary blocks
- **Lightweight** — SQLite + in-memory cache, no external DB required

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│  GitHub Repo    │────▶│  github-sync.js  │──┐
│  (metadata)     │     │  (hourly)        │  │
└─────────────────┘     └──────────────────┘  │
                                               ▼
┌─────────────────┐     ┌──────────────────┐  ┌─────────────┐
│ monad-ledger-   │────▶│    logger.js     │─▶│   SQLite    │
│ tail (logs)     │     │  (real-time)     │  │  monad.db   │
└─────────────────┘     └──────────────────┘  └──────┬──────┘
                                                      │
┌─────────────────┐     ┌──────────────────┐          │
│ Staking         │────▶│  status-sync.js  │──────────┘
│ Precompile      │     │  (epoch watcher) │          │
└─────────────────┘     └──────────────────┘          │
                                                      ▼
                        ┌──────────────────┐   ┌─────────────┐
                        │    index.js      │◀──│  staking.js │
                        │  (Express API)   │   │  (RPC+cache)│
                        └───────┬──────────┘   └─────────────┘
                                │ HTTP
                         ┌──────┴──────┐
                         │   Clients   │
                         └─────────────┘
```

## Data Sources

| Source | What | Freshness |
|--------|------|-----------|
| **SQLite (cached)** | Validator list, stake, commission, uptime stats, pool totals | Synced hourly + on epoch change |
| **Live RPC** | `/staking/validator/:id`, `/staking/delegator/:addr`, epoch info | Real-time (30s in-memory cache) |
| **GitHub** | Validator names, logos, websites, social links | Hourly |

## Setup

```bash
git clone <repo> monad-api && cd monad-api
npm install
cp .env.example .env   # edit with your values
npm run sync            # initial metadata sync
npm start               # start API server
```

## Processes

| Process | Command | Description |
|---------|---------|-------------|
| API Server | `npm start` | Express HTTP server + status sync + epoch watcher |
| Uptime Logger | `npm run logger` | journalctl → SQLite (real-time) |
| Metadata Sync | Built-in | Runs inside API server (hourly) |
| Status Sync | Built-in | Runs inside API server (hourly + epoch transitions) |

## API Endpoints

**Base URL:** `http://localhost:3000/monad-api`

### Validators

```
GET /monad-api/validators                        # All validators (metadata + stake)
GET /monad-api/validators/:idOrAddress           # Single validator by ID or secp address
GET /monad-api/validators/uptime                 # All validators uptime (?window=24&sort=uptime)
GET /monad-api/validators/uptime/:idOrAddress    # Single validator uptime
GET /monad-api/validators/uptime/:id/history     # Round-by-round history (?limit=49)
GET /monad-api/validators/stats                  # Validator count
```

### Staking (On-Chain)

```
GET /monad-api/staking/epoch                     # Current epoch + in_delay_period
GET /monad-api/staking/pool                      # Bonded tokens, total staked, on-chain validator counts
GET /monad-api/staking/validator/:id             # Validator stake, commission, rewards (live)
GET /monad-api/staking/validator/:id/delegators  # All delegators of a validator (live)
GET /monad-api/staking/delegator/:address        # All delegations for an address (live)
```

### System

```
GET /health                                      # Health check
GET /monad-api                                   # API info & endpoint list
```

### Example Responses

**`GET /monad-api/staking/pool`**
```json
{
  "success": true,
  "bonded_tokens": 12300712423.81,
  "total_staked": 12303076653.87,
  "execution_validators": 187,
  "consensus_validators": 170,
  "epoch": 1163,
  "in_delay_period": false
}
```

**`GET /monad-api/staking/validator/41`**
```json
{
  "success": true,
  "validator": {
    "id": 41,
    "name": "Allnodes",
    "secp_address": "0x8a5a...",
    "status": "active",
    "stake": 11000000,
    "commission": 10,
    "unclaimed_rewards": 54150.55,
    "auth_address": "0x8a5a..."
  }
}
```

**`GET /monad-api/staking/delegator/0xbf4b...`**
```json
{
  "success": true,
  "address": "0xBF4b...",
  "total_staked": 100000,
  "total_rewards": 18868.75,
  "delegation_count": 1,
  "delegations": [
    {
      "validator_id": 40,
      "validator_name": "Huginn",
      "validator_status": "active",
      "stake": 100000,
      "unclaimed_rewards": 18868.75
    }
  ]
}
```

### Query Parameters

| Endpoint | Param | Default | Range | Description |
|----------|-------|---------|-------|-------------|
| `/uptime` | `window` | 24 | 1-168 | Hours window |
| `/uptime` | `sort` | uptime | uptime, id | Sort order |
| `/uptime/:id/history` | `limit` | 49 | 1-100 | Number of rounds |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | API port |
| `HOST` | 0.0.0.0 | Bind address |
| `MONAD_RPC_URL` | http://127.0.0.1:8080 | Monad RPC endpoint |
| `JOURNAL_UNIT` | monad-ledger-tail | Systemd unit for log tailing |
| `GITHUB_RAW_BASE` | ...validator-info/main/mainnet | Metadata source |
| `METADATA_SYNC_INTERVAL_MS` | 3600000 | Metadata sync interval (1h) |
| `STATUS_SYNC_INTERVAL_MS` | 3600000 | Staking data sync interval (1h) |
| `EPOCH_POLL_MS` | 120000 | Epoch watcher poll interval (2min) |
| `UPTIME_RETENTION_HOURS` | 48 | Old event cleanup threshold |
| `LOG_LEVEL` | info | error / warn / info / debug |

## Systemd (Production)

See `services.txt` for systemd unit files. Quick setup:

```bash
sudo cp systemd/monad-api.service /etc/systemd/system/
sudo cp systemd/monad-uptime-logger.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now monad-api monad-uptime-logger
```

## Notes

- All monetary values are returned as **raw numbers** (not formatted strings) for safe client-side parsing
- **30s in-memory cache** on live RPC calls prevents redundant queries under burst traffic
- **Epoch watcher** polls every 2 minutes and triggers a full sync on epoch transitions or boundary blocks
- Validator counts (`execution_validators`, `consensus_validators`) are sourced directly from on-chain validator sets
- SQLite WAL mode enables concurrent reads/writes
- GitHub sync failures preserve existing data (no data loss)

## License

MIT
