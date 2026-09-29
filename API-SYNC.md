# JEV BRAIN · Frontend ⇄ Backend 1:1 Sync Manifest

> **Purpose:** Document the complete, validated mapping between the **frontend** (`public/`) and the **backend** (`src/server.js` + `src/core/*` + `src/workers/*`), and the **deployment wiring** that keeps them same-origin in every hosting mode.
>
> Status: `VALIDATED` ✅ — every frontend API call below resolves to a real backend route; secrets are blocked from every build context (see [Deployment & Security](#-deployment--security-1-1-sync)).

---

## 🌐 Architecture (monorepo)

```
public/                 ← FRONTEND (static HTML/CSS/JS — the ONLY thing users' browsers get)
src/server.js           ← BACKEND (all ~60 /api/* routes, static serving, daemons)
src/core/*, src/workers/*  ← business logic (warden, credits, burn, rewards, p2p, dex…)
api/index.js            ← Vercel serverless wrapper → src/server.js
bin/brain.js            ← CLI + `serve` command (Railway start)
data/                   ← USER DATA (jev-brain.db, jev-state.json) — NEVER in build/images
```

Frontend calls the backend through **relative `/api/*` URLs** → keeps the browser origin same everywhere (no cross-origin/CORS friction).

---

## 📋 API ⇄ Consumer 1:1 Map (all routes exist in `src/server.js`)

### Auth & Wallet
| Method | Endpoint | Frontend page | CLI / SDK / Daemon |
|---|---|---|---|
| GET | `/api/wallet/nonce` | app.js · api-keys.html · verify.html | bin/brain.js |
| POST | `/api/wallet/verify-signature` | app.js · api-keys.html | bin/brain.js |
| GET | `/api/wallet/status` | app.js | — |
| GET | `/api/session/validate` | app.js | — |
| GET | `/api/holder/eligibility` | app.js · api-keys.html | — |
| GET | `/api/user/profile` | app.js | — |
| POST | `/api/user/profile` | app.js | — |

### Chat / Router / Models
| Method | Endpoint | Frontend page | CLI / SDK / Daemon |
|---|---|---|---|
| GET | `/api/models` | app.js | bin/brain.js |
| GET | `/api/presets` | app.js | SDK |
| GET | `/api/chat`\* | app.js | CLI terminal |
| GET/POST | `/api/chat/stream` (SSE) | app.js | — |
| GET/POST | `/api/chats` | app.js | — |
| GET/POST | `/api/artifacts` | app.js | — |
| GET/POST | `/api/projects` | app.js | — |
| POST | `/api/route` | app.js | SDK / bin/brain.js |
| POST | `/api/batch` | — | SDK |
| POST | `/api/warden` | — | SDK / GitHub Action |
| POST | `/api/warden-check` | app.js | bin/brain.js |
| GET | `/api/benchmark/matrix` | roadmap.html | CLI |
| POST | `/api/benchmark/run` | — | CLI |

\* `/api/chat` non-stream variant is also handled by `src/server.js`.
### Credits / Rewards / Burn / P2P
| Method | Endpoint | Frontend page | CLI / SDK / Daemon |
|---|---|---|---|
| POST | `/api/credits/accrue` | — | holder-accrual-daemon |
| GET | `/api/credits/balance` | app.js · api-keys.html | bin/brain.js |
| GET | `/api/credits/history` | app.js | — |
| POST | `/api/credits/burn` | burning-day.html | — |
| GET | `/api/credits/burn-quote` | burning-day.html | — |
| POST | `/api/credits/transfer` | — | CLI |
| GET | `/api/boost/status` | app.js | — |
| POST | `/api/boost/burn-verify` | burning-day.html | — |
| GET/POST | `/api/rewards/transparency` | burning-day.html | — |
| POST | `/api/rewards/redeem` | app.js | — |
| GET | `/api/pool/status` | burning-day.html | — |
| GET | `/api/market-info` | app.js | — |
| GET | `/api/solana/latest-blockhash` | burning-day.html | — |
| GET | `/api/p2p/orders` | burning-day.html | — |
| POST | `/api/p2p/orders/create` | burning-day.html | — |
| POST | `/api/p2p/orders/cancel` | burning-day.html | — |
| POST | `/api/p2p/orders/lock` | burning-day.html | — |
| POST | `/api/p2p/orders/fulfill` | burning-day.html | — |
| POST | `/api/p2p/orders/retry-payout` | — | p2p-market-engine |
| GET | `/api/p2p/quote` | burning-day.html | — |
| GET | `/api/p2p/stats` | burning-day.html | — |

### API Keys, Discord, Operator, Mobile, System
| Method | Endpoint | Frontend page | CLI / SDK / Daemon |
|---|---|---|---|
| GET | `/api/keys` | api-keys.html | — |
| GET | `/api/keys/status` | api-keys.html | — |
| POST | `/api/keys/generate` | api-keys.html | — |
| POST | `/api/keys/revoke` | api-keys.html | — |
| POST | `/api/keys/delete` | api-keys.html | — |
| GET | `/api/discord/info` | verify.html | discord/bot.js |
| POST | `/api/discord/verify` | verify.html | — |
| POST | `/api/discord/exchange-code` | verify.html | — |
| POST | `/api/discord/verify-human` | verify.html | — |
| GET | `/api/harvester/trigger` | — | fee-harvester |
| GET | `/api/reconciler/status` | — | payment-reconciler |
| GET | `/api/operator/claims` | — | operator-service |
| POST | `/api/operator/harvest` | — | operator-service |
| GET | `/api/mobile/devices` | — | MobileRunner |
| GET | `/api/mobile/logs` | — | MobileRunner |
| GET | `/api/mobile/screen` | — | MobileRunner |
| POST | `/api/mobile/action` | — | MobileRunner |
| GET | `/api/stats` | app.js (health) | Railway healthcheck |

**Result:** All frontend calls have a 1:1 backend route. No orphan frontend endpoint, no missing backend route detected.
---

## 🔄 Deployment & Security 1:1 Sync

| Host | Serves | Backend wiring | Same-origin? |
|---|---|---|---|
| **Railway** (main) | `node bin/brain.js serve` → `src/server.js` (static + API) | Same process; data on `/data` volume | ✅ native |
| **Netlify** (`jevbrain.world`) | `public/` static | `_redirects` + `netlify.toml`: `/api/*` → `https://jevbrain-backend-production.up.railway.app/api/:splat` (200 proxy) | ✅ CDN proxy |
| **Vercel** | `public/**` + `api/index.js` (serverless) | `vercel.json`: `/api/(.*)` → `/api/index.js` → `src/server.js`; `/(.*)` → `/public/$1` | ✅ same-repo |

> All three configured for **transparent same-origin** calls from the browser — no CORS round-trips.

### 🔐 Secret / user-data build guards (validated this audit)
- **`.dockerignore`** — NEW. Excludes `.env*`, `data/`, `*.db`, `test/`, `.git/`, media, python from the Docker build context (fixes the `COPY . .` leak in `Dockerfile`). User data stays only on `/data`.
- **`.vercelignore`** — HARDENED. Now excludes `.env*`, `data/`, `*.db`, `.git/`, `scripts/`, `samples/`.
- **`.gitignore`** — already ignores `.env`, `.env.local`, `data/je*-*.json`, `*.db`, `*.db-wal`, `*.db-shm`; verified `.env` was never committed in git history.
- **Server static handler** — path-traversal guarded (`filePath.startsWith(PUBLIC_DIR)` → 403), so `.env`/`data/` are never web-readable on Railway.
- **API surface** — audited: no endpoint returns `process.env` secret values; financial/harvest/operator endpoints are authorization-gated and only expose **public** wallet addresses.

---

## 🧪 How to verify sync locally
```bash
npm start                # Railway-equivalent: serves public/ + /api/* on :3333
curl http://localhost:3333/api/stats        # health
curl http://localhost:3333/api/models       # frontend models list
# Open http://localhost:3333  → workspace + burning-day + verify all call /api/* same-origin
```