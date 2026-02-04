# Monad Validator API

Monad validatorleri için metadata ve uptime tracking API'si.

## Özellikler

- ✅ **Validator Metadata**: GitHub'dan otomatik sync (saatlik)
- ✅ **Uptime Tracking**: Real-time log analizi (finalized/timeout)
- ✅ **Çift Lookup**: Validator ID veya 0x adres ile sorgulama
- ✅ **Rolling Window**: Son 24 saat (veya özelleştirilebilir) uptime
- ✅ **Lightweight**: SQLite tabanlı, MongoDB gerektirmez

## Mimari

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  GitHub Repo    │────▶│  github-sync.js  │────▶│             │
│  (metadata)     │     │  (saatlik)       │     │   SQLite    │
└─────────────────┘     └──────────────────┘     │   Database  │
                                                  │             │
┌─────────────────┐     ┌──────────────────┐     │  monad.db   │
│ monad-ledger-   │────▶│    logger.js     │────▶│             │
│ tail (logs)     │     │  (real-time)     │     └──────┬──────┘
└─────────────────┘     └──────────────────┘            │
                                                        │
                        ┌──────────────────┐            │
                        │    index.js      │◀───────────┘
                        │   (Express API)  │
                        └──────────────────┘
                               ▲
                               │ HTTP
                        ┌──────┴──────┐
                        │   Clients   │
                        └─────────────┘
```

## Kurulum

```bash
# Clone & Install
cd /opt
git clone <repo> monad-api
cd monad-api
npm install

# .env dosyası oluştur
cp .env.example .env
nano .env

# İlk metadata sync
npm run sync

# Test et
npm start
```

## Servisler

3 ayrı proses çalışır:

| Proses | Komut | Açıklama |
|--------|-------|----------|
| API Server | `npm start` | Express HTTP server |
| Uptime Logger | `npm run logger` | journalctl → SQLite |
| Metadata Sync | Otomatik | API içinde çalışır |

### Systemd ile Production

```bash
# Servis dosyalarını kopyala
sudo cp systemd/monad-api.service /etc/systemd/system/
sudo cp systemd/monad-uptime-logger.service /etc/systemd/system/

# Etkinleştir ve başlat
sudo systemctl daemon-reload
sudo systemctl enable --now monad-api monad-uptime-logger

# Durumu kontrol et
sudo systemctl status monad-api monad-uptime-logger
```

## API Endpoints

### Base URL
```
http://localhost:3000/monad-api
```

### Endpoints

#### 1. Tüm Validatorler
```bash
GET /monad-api/validators
```

Response:
```json
{
  "success": true,
  "count": 50,
  "validators": [
    {
      "id": 1,
      "secp_address": "0x1234...",
      "bls_public_key": "0xabc...",
      "name": "Validator One",
      "website": "https://...",
      "description": "...",
      "logo_url": "https://..."
    }
  ]
}
```

#### 2. Tek Validator (ID veya Adres)
```bash
# ID ile
GET /monad-api/validators/1

# 0x adresi ile
GET /monad-api/validators/0x1234abcd...
```

Response:
```json
{
  "success": true,
  "validator": {
    "id": 1,
    "secp_address": "0x1234...",
    "name": "Validator One",
    ...
  }
}
```

#### 3. Tüm Validatorlerin Uptime'ı
```bash
GET /monad-api/validators/uptime
GET /monad-api/validators/uptime?window=12&sort=uptime
```

Query params:
- `window`: Saat (1-168, varsayılan 24)
- `sort`: `uptime` (azalan) veya `id` (artan)

Response:
```json
{
  "success": true,
  "window_hours": 24,
  "count": 50,
  "validators": [
    {
      "validator_id": 1,
      "validator_name": "Validator One",
      "secp_address": "0x1234...",
      "window_hours": 24,
      "finalized_count": 8640,
      "timeout_count": 10,
      "total_events": 8650,
      "uptime_percent": 99.88,
      "since_timestamp": 1706000000,
      "since_utc": "2024-01-23T12:00:00.000Z"
    }
  ]
}
```

#### 4. Tek Validator Uptime
```bash
GET /monad-api/validators/uptime/1
GET /monad-api/validators/uptime/0x1234...?window=6&limit=50
```

Query params:
- `window`: Saat (1-168, varsayılan 24)
- `limit`: Son event sayısı (1-1000, varsayılan 100)

Response:
```json
{
  "success": true,
  "uptime": {
    "validator_id": 1,
    "validator_name": "Validator One",
    "uptime_percent": 99.88,
    ...
  },
  "recent_events": [
    {
      "round": 123456,
      "event_type": "finalized",
      "timestamp": 1706086400,
      "timestamp_utc": "2024-01-24T12:00:00.000Z"
    }
  ]
}
```

#### 5. Health Check
```bash
GET /health
```

## Environment Variables

| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `PORT` | 3000 | API port |
| `HOST` | 0.0.0.0 | Bind address |
| `JOURNAL_UNIT` | monad-ledger-tail | Systemd unit adı |
| `GITHUB_RAW_BASE` | ...validator-info/main/mainnet | Metadata kaynağı |
| `METADATA_SYNC_INTERVAL_MS` | 3600000 | Metadata sync sıklığı (1 saat) |
| `UPTIME_RETENTION_HOURS` | 48 | Eski eventleri temizle |
| `UPTIME_WINDOW_HOURS` | 24 | Varsayılan uptime penceresi |
| `LOG_LEVEL` | info | error/warn/info/debug |

## Mevcut Projenle Entegrasyon

`timeout-monitor.js` dosyanızla birlikte çalışabilir. Her iki sistem de aynı `journalctl` kaynağını okur:

```bash
# Terminal 1: Timeout Monitor (Telegram alerts)
node timeout-monitor.js

# Terminal 2: Uptime Logger (SQLite'a yazar)
npm run logger

# Terminal 3: API Server
npm start
```

## Notlar

- **Metadata güvenliği**: GitHub'dan çekilemezse mevcut data korunur
- **SQLite WAL mode**: Concurrent read/write destekler
- **Memory efficient**: Event buffer ile batch insert
- **Dedupe**: Aynı round tekrar kaydedilmez

## Lisans

MIT
