# Project State — StickerinAja

**Last updated:** 2026-07-14 16:00 WIB (+0700)
**Last verified commit:** `20d4999` — "chore: add agent docs to .gitignore"
**Last verified tests:** 196/196 pass (74 Reddit + 23 baseline + 20 contentHistory + 20 groqNewsEditor + 18 fxRateProvider + 21 fxRateService + 9 fxCommands + 11 fxCron)

---

## Architecture Overview

WhatsApp Sticker Maker Bot running on Baileys WebSocket + Koyeb Docker deployment.

```
WhatsApp (Baileys) → Command Handler (auto-load src/commands/) → Services
                   → Cron Schedulers (node-cron) → Services
                   → Turso/libSQL (persistent storage)
                   → HTTP Server (:8000) — health, QR, Hermes relay
```

**Runtime:** Node.js 20+ on Koyeb (Docker)
**Database:** Turso (libSQL) with memory fallback
**Scheduler:** node-cron (Asia/Jakarta timezone)
**Logging:** Pino (pino-pretty in dev, JSON in production)

---

## Active Features

| Feature | Status | Files |
|---------|--------|-------|
| Sticker creation | ✅ Active | `src/commands/sticker.js`, `src/utils/textRenderer.js` |
| Reddit Sticker Bank | ✅ Active | `src/services/redditSticker*.js`, `src/commands/reddit.js`, `src/scheduler/redditStickerCron.js` |
| News Service (Morning/Midday/Evening/Nightcap) | ✅ Active | `src/services/newsService.js`, `src/services/groqNewsEditor.js` |
| USD/IDR Market Intelligence | ✅ Active | `src/services/fxRate*.js`, `src/repositories/fxRepository.js`, `src/commands/fx.js`, `src/scheduler/fxCron.js` |
| Birthday Takeover | 🔧 Stub only | `src/services/birthdayTakeoverService.js` |
| Hermes Relay | ✅ Active | `src/baileys.js` endpoints |

---

## Environment Variables

**Template:** `.env.example` (6 sections: Basic, Environment, Storage, Groq AI, You.com API, Reddit Sticker Bank)

Key variables:
- `PREFIX` — Command prefix (default: `!`)
- `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` — Turso/libSQL credentials
- `YDC_API_KEY` — You.com Web Search API
- `GROQ_API_KEY_PRIMARY` / `GROQ_API_KEY_SECONDARY` — Groq AI
- `OPEN_EXCHANGE_RATES_APP_ID` — Open Exchange Rates (new, for FX feature)
- `GROUP_JID` — Target WhatsApp group JID

---

## Cron Schedules

| Job | Schedule | Timezone |
|-----|----------|----------|
| Reddit sticker generator | `0 5 * * *` | Asia/Jakarta |
| Reddit sticker sender | `0 10,18 * * *` | Asia/Jakarta |
| Temp file cleanup | Every 60s | N/A |
| FX rate collection + delivery | `5 * * * *` | Asia/Jakarta |
| FX market context refresh | `15 */3 * * *` | Asia/Jakarta |

---

## Commands

| Command | Module | Access |
|---------|--------|--------|
| `!sticker`, `!s`, `!stiker` | `sticker.js` | Public |
| `!menu`, `!help` | `menu.js` | Public |
| `!settings`, `!set` | `settings.js` | Public |
| `!reddit`, `!meme`, `!rbank`, etc. | `reddit.js` | Mixed |
| `!usd`, `!kurs` (planned) | `fx.js` | Public |
| `!usdrefresh`, `!usdquota` (planned) | `fx.js` | Admin |

---

## Known Limitations

| Limitation | Status |
|------------|--------|
| All Phase 1 gaps resolved | ✅ Fixed — `groqNewsEditor.js`, `contentHistory.js`, `node-cron`, `PROJECT_STATE.md` |
| News Service + FX Groq integration not yet live-tested | ⚠️ Not verified |
| No shared Turso client for Reddit (FX uses `tursoClient.js`) | ⚠️ Known limitation |
| Koyeb deployment status | ⚠️ Not verified |
| WhatsApp smoke test | ⚠️ Not verified |
| FX historical backfill not yet executed | ⚠️ Requires OER App ID configured |
| OER API quota management | ⚠️ Not yet validated in production |

---

## Last Test Results

| Date | Suite | Tests | Pass | Fail |
|------|-------|-------|------|------|
| 2026-07-14 | Reddit Sticker (test/redditSticker.test.js) | 74 | 74 | 0 |
| 2026-07-14 | Baseline Runtime (test/baselineRuntime.test.js) | — | — | — |

---

## Deployment

- **Platform:** Koyeb (Docker-based)
- **Status:** Not verified — no Koyeb API access
- **Dockerfile:** Present at `Dockerfile`

---

## Git State

- **Branch:** `main`
- **Remote:** `origin` → `https://github.com/algojogacor/StickerinAja`
- **Working tree:** Changes in progress (Phase 1 repairs)

---

## Next Actions

1. Complete Phase 1 validation gate
2. Implement Phase 2 (USD/IDR Market Intelligence)
3. Run all tests
4. Update documentation
5. Commit (when authorized)
