# Project State — StickerinAja

**Last updated:** 2026-08-31 WIB (+0700)
**Current implementation:** Dynamic Group Delegation by Bot Membership + Groq AI Vision & Text Chat (`!ai`, `!tanya`, `!vision`, `!gpt`) + Meme-API & GIPHY Sticker Bank + 24-Hour Round-the-Clock Scheduler (48 Daily Sends) + Fresh On-Demand Delivery + EXIF Metadata Injection committed on `main`; `.env` remains local/ignored
**Last verified tests:** 301/301 pass across 64 test suites; multi-session & AI Vision 100% pass

---

## Architecture Overview

WhatsApp Sticker Maker Bot running on Baileys WebSocket + Koyeb Docker deployment.

```text
WhatsApp (Baileys) → Command Handler (auto-load src/commands/) → Services
                   → Absolute-slot schedulers (recursive setTimeout) → Services
                   → Turso/libSQL (persistent storage)
                   → HTTP Server (:8000) — health, QR, Hermes relay
```

**Runtime:** Node.js 20+ on Koyeb (Docker)
**Database:** Turso (libSQL), with feature-specific fallback behavior
**Scheduler:** `src/scheduler/windowedScheduler.js`, fixed Asia/Jakarta offset, supports 24-hour round-the-clock scheduling (`SCHEDULER_ALLOW_24_HOURS=true`) or windowed 07:00-22:00 WIB
**Logging:** Pino (`pino-pretty` in development, JSON in production)

The scheduler uses one recursive `setTimeout` per active job. After each callback it recalculates the next absolute wall-clock slot, so runtime delay does not accumulate into long-term drift. Schedulers prioritize the `bot` session socket for delivery.

---

## Active Features

| Feature | Status | Files |
|---|---|---|
| Sticker creation | Active; modularized into specialized services, pure Sharp + SVG compositing, zero `canvas` native dependency | `src/commands/sticker.js`, `src/services/sticker/*.js`, `src/utils/textRenderer.js` |
| Groq AI Vision & Chat | Active; multimodal image analysis (`qwen/qwen3.8-27b`), OCR/text reading, meme explanation, and text chat (`!ai`, `!tanya`, `!vision`, `!gpt`, `!baca`, `!deskripsi`) with automatic key rotation | `src/services/aiVisionService.js`, `src/commands/ai.js`, `test/aiVision.test.js` |
| Selfbot / Multi-Session | Active; configurable via `BOT_MODE=dual\|self\|public` and `MULTI_SESSION=true` / `SESSIONS`, supports running 2 isolated WhatsApp numbers simultaneously in 1 Koyeb container with group deduplication and bot priority | `src/handler.js`, `src/baileys.js`, `src/core/socket.js`, `src/utils/login.html`, `index.js` |
| Web QR Code Login | Active; self-hosted vector SVG generation via `qrHelper.js`, multi-session tabbed dashboard in `login.html`, zero external API calls | `src/utils/qrHelper.js`, `src/utils/login.html`, `index.js` |
| Meme & GIPHY Sticker Bank | Active; Meme-API (100% free static photo memes) + GIPHY API (animated GIFs & transparent stickers), 100% on-demand fresh fetch (zero recycled sent stickers), EXIF metadata injection (`STICKERIN_BOT_NAME` & `STICKERIN_AUTHOR`), duplicate/removed-post protection, short-video support, and 24-hour scheduled delivery (48 sends/day: 1 photo + 1 animated video every hour via bot session) | `src/services/redditSticker*.js`, `src/commands/reddit.js`, `src/scheduler/redditStickerCron.js`, `src/repositories/redditStickerRepository.js` |
| News Service | Code preserved & ready; scheduler paused via `NEWS_SCHEDULER_ENABLED=false` | `src/services/newsService.js`, `src/services/groqNewsEditor.js`, `src/scheduler/newsScheduler.js` |
| USD/IDR Market Intelligence | Code preserved & ready; scheduler paused via `FX_USD_IDR_ENABLED=false` | `src/services/fxRate*.js`, `src/repositories/fxRepository.js`, `src/commands/fx.js`, `src/scheduler/fxCron.js` |
| Birthday Takeover | Active; Turso-backed CRUD, idempotent daily takeover events, wish collection, and windowed WIB scheduler | `src/config/birthdayConfig.js`, `src/repositories/birthdayRepository.js`, `src/services/birthdayService.js`, `src/scheduler/birthdayScheduler.js`, `src/commands/birthday.js` |
| Hermes Relay | Active | `src/baileys.js`, `index.js` |

---

## Scheduler Slots

All times are Asia/Jakarta (WIB).

| Job | Slots |
|---|---|
| Reddit sticker generator | Configurable; default 6 slots across 24h (`00:00, 04:00, 08:00, 12:00, 16:00, 20:00`) |
| Reddit sticker sender | Configurable; default 96 slots every 15 minutes across 24h (`:00` & `:30` for Photo Memes; `:15` & `:45` for Animated Video GIFs) sending 1 sticker each (96 stickers/day: 48 photos + 48 GIFs) |
| News briefing | 07:00, 12:00, 17:00, 22:00 (paused) |
| FX rate collection + delivery | Hourly at `:05` (paused) |
| FX market context refresh | 07:15, 10:15, 13:15, 16:15, 19:15 (paused) |
| Birthday Takeover | 07:00, 09:00, 12:00, 15:00, 18:00, 21:00, 22:00 when today has birthday records |

The legacy filenames `redditStickerCron.js`, `fxCron.js`, and legacy Reddit toggle names remain for internal compatibility, but neither module imports or runs `node-cron`.

---

## Scheduler Slots

All times are Asia/Jakarta (WIB). No application delivery job is scheduled outside 07:00–22:00.

| Job | Absolute daily slots |
|---|---|
| News briefing | 07:00, 12:00, 17:00, 22:00 |
| Reddit sticker generator | Configurable; default 5 slots distributed from 07:00 through 21:00 WIB |
| Reddit sticker sender | Configurable; default 10 slots from 08:00 through 22:00 WIB |
| FX rate collection + delivery | Hourly at `:05`, from 07:05 through 21:05 |
| FX market context refresh | 07:15, 10:15, 13:15, 16:15, 19:15 |
| Birthday Takeover | 07:00, 09:00, 12:00, 15:00, 18:00, 21:00, 22:00 when today has birthday records |

The temp-file cleanup timer in `index.js` remains a 60-second maintenance interval. It deletes old local temp files and does not deliver content or depend on a wall-clock schedule.

---

## Connection and Retry Behavior

- `src/baileys.js` sets the shared socket only after `connection === "open"`.
- A close event clears the socket only when it belongs to that exact socket instance; a stale close event cannot clear a newer reconnect socket.
- On every successful connection open, News, Reddit, and FX schedulers call `resume()`; the shared window guard refuses delivery outside 07:00–22:29 WIB.
- A pending scheduler task never overlaps itself.
- News keeps partially delivered multi-message state and resumes from the first unsent part.
- FX keeps persistent execution-slot idempotency. A failed delivery slot can be atomically reacquired for a reconnect retry.
- Pending in-memory delivery state does not survive a full process restart. Persistent FX slot state survives through Turso; News and Reddit retain their existing feature-level idempotency limitations.

---

## Environment Variables

**Authoritative template:** `.env.example`

Relevant toggles and targets:

- `GROUP_JID` — default target WhatsApp group.
- `NEWS_SCHEDULER_ENABLED` — enables the four news slots; default `true`.
- `REDDIT_STICKER_GENERATOR_ENABLED` — enables Reddit generation slots; count/times are controlled by `REDDIT_STICKER_GENERATIONS_PER_DAY` or `REDDIT_STICKER_GENERATE_TIMES`.
- `REDDIT_STICKER_SENDER_ENABLED` — enables Reddit delivery slots; `REDDIT_STICKER_SENDS_PER_DAY=10` gives ten sends per day by default.
- `REDDIT_STICKER_SEND_TIMES` / `REDDIT_STICKER_GENERATE_TIMES` — optional explicit WIB slot lists; otherwise slots are distributed automatically inside 07:00–22:00.
- `REDDIT_SEARCH_SUBREDDITS` / `REDDIT_SEARCH_MAX_QUERIES` — controls the diverse meme-community discovery set and query cap.
- `REDDIT_STICKER_GENERATE_COUNT` — target stickers per generation slot (default 2; duplicates and unusable media may reduce the result).
- `REDDIT_ALLOW_NSFW` / `REDDIT_ALLOW_SPOILER` — enabled by default for this opted-in group; set either variable to `false` to re-enable that filter. You.com discovery uses `safesearch=off` unless NSFW is explicitly disabled.
- `REDDIT_STICKER_CRON_ENABLED` — legacy-compatible runtime sender toggle name.
- `FX_USD_IDR_ENABLED` / `FX_USD_IDR_AUTO_SEND_ENABLED` — FX scheduler toggles.
- `FX_USD_IDR_TARGET_JID` — FX-specific delivery target, falling back to `GROUP_JID`.
- `FX_MARKET_CONTEXT_ENABLED` — enables the five context-refresh slots.
- `BIRTHDAY_FEATURE_ENABLED` / `BIRTHDAY_TAKEOVER_ENABLED` — enable Birthday Takeover and suppression of News/Reddit/FX for the target group.
- `BIRTHDAY_SONG_URL` — text fallback URL when no local audio file exists.
- `BIRTHDAY_AUDIO_PATH`, `BIRTHDAY_CARD_PATH`, `BIRTHDAY_STICKER_PATH` — optional files bundled into the deployment image/volume.
- `BIRTHDAY_WISH_MAX_LENGTH` — maximum stored reply length (50–2000 characters).

The removed variables `FX_USD_IDR_CRON`, `FX_MARKET_CONTEXT_CRON`, `FX_USD_IDR_RUN_24_HOURS`, and `FX_USD_IDR_TIMEZONE` are no longer read. Slot definitions are intentionally fixed in source to enforce the 07:00–22:00 policy.

For short local smoke tests only, `SCHEDULER_TEST_INTERVAL_MINUTES` temporarily replaces daily slot timing for that process. It accepts integers from 1 through 60, is intentionally not stored in `.env`, and must not be configured on Koyeb. When absent, all production slots above remain unchanged.

---

## Commands

Manual command behavior is unchanged. The scheduler migration only affects background jobs.

| Command | Module | Access |
|---|---|---|
| `!sticker`, `!s`, `!stiker` | `sticker.js` | Public |
| `!menu`, `!help` | `menu.js` | Public |
| `!settings`, `!set` | `settings.js` | Public |
| `!reddit`, `!meme`, `!rbank`, aliases | `reddit.js` | Mixed |
| `!usd`, `!kurs` | `fx.js` | Public |
| `!usdrefresh`, `!usdquota`, admin aliases | `fx.js` | Admin |
| `!ultah`, `!birthday` | `birthday.js` | Group admin/owner for mutations; read-only queries for members |

---

## Last Verification

| Date | Command | Result |
|---|---|---|
| 2026-07-15 | `node --test test/redditSticker.test.js` | 74 pass, 0 fail, 0 skipped |
| 2026-07-15 | Explicit `node --test` over every `test/*.test.js` file | 235 pass, 0 fail, 0 skipped; 48 suites |
| 2026-07-15 | `node --test` after adding the local interval override and native-module load regression | 239 pass, 0 fail, 0 skipped; 49 suites |
| 2026-07-15 | `node --test` after fixing Reddit discovery, You.com metadata, score handling, retry, and Sticker Bank persistence | 246 pass, 0 fail, 0 skipped; 51 suites |
| 2026-07-15 | `node --test test/redditSticker.test.js` after removed-post filtering and ready-only sender policy | 83 pass, 0 fail, 0 skipped |
| 2026-07-15 | `node --test` after removed-post filtering and ready-only sender policy | 248 pass, 0 fail, 0 skipped; 52 suites |
| 2026-07-15 | Live You.com discovery and generation smoke test | 1 Reddit candidate found; 1 static sticker generated and stored as `ready` (19.4 KB) |
| 2026-07-15 | Restarted local Node 20 test process after Reddit fix | PID `25644`; health `ok`; WhatsApp and both Sticker/FX Turso stores connected; five-minute test schedulers armed; stderr empty |
| 2026-07-15 | Fixed-process scheduled Reddit delivery | `Sticker sent (1)` observed for Reddit post `1uu5s34` after the next five-minute tick |
| 2026-07-15 | `node --check` for runtime and scheduler modules | Pass |
| 2026-07-15 | `git diff --check` | Pass; only line-ending conversion warnings |
| 2026-07-15 | Local Node 20 startup with `SCHEDULER_TEST_INTERVAL_MINUTES=5` | Health `ok`; WhatsApp, Reddit Turso, and FX Turso connected; five scheduler jobs armed at five-minute cadence; stderr empty |
| 2026-07-15 | Restarted local Node 20 process after sender/filter fix | PID `36744`; `GET http://127.0.0.1:8000/health` returned `200`/`status: ok`; WhatsApp and Turso connected; stderr empty |
| 2026-07-15 | Isolated Reddit direct smoke test with News/FX/Reddit schedulers disabled | Generated one valid static sticker (`1uvm5wo`) and sent it through Baileys (`sent: 1`); test process stopped afterward |
| 2026-07-15 | `node --test test/redditSticker.test.js` after quality/media updates | 91 pass, 0 fail, 0 skipped |
| 2026-07-15 | `node --test test/redditSticker.test.js test/schedulerConfiguration.test.js` after opted-in NSFW policy | 95 pass, 0 fail, 0 skipped |
| 2026-07-15 | `node --test` after quality/media updates | 256 pass, 0 fail, 0 skipped; 52 suites |
| 2026-07-15 | `node --test` after opted-in NSFW policy | 257 pass, 0 fail, 0 skipped; 52 suites |
| 2026-07-15 | Live You.com discovery with targeted subreddit queries | 10 candidates after fallback; generic/removed rows remained marked, and meme communities supplied usable candidates |
| 2026-07-15 | Live Turso generation smoke with meme-quality gate | 4/7 eligible candidates classified as meme; selected `funny` + `starterpacks`; 1 new static sticker persisted as `ready` after the other candidate was a duplicate |
| 2026-07-15 | Short-video normalization and eligibility checks | Direct `v.redd.it` MP4 hint resolves as video; known duration 8 seconds allowed and 11 seconds rejected with the 10-second limit |
| 2026-07-15 | Opted-in adult-content policy | `REDDIT_ALLOW_NSFW=true` and `REDDIT_ALLOW_SPOILER=true` documented/configured; resolver allows by default and You.com uses `safesearch=off` unless explicitly disabled |
| 2026-07-15 | Configurable Reddit frequency | `.env` set to 5 generator slots and 10 sender slots; loaded production configuration resolved to 5 generation times and 10 send times, all inside 07:00–22:00 WIB |
| 2026-07-15 | `node --test` after configurable Reddit frequency | 259 pass, 0 fail, 0 skipped; 52 suites |
| 2026-07-15 | `node --test test/birthday.test.js` | 8 pass, 0 fail, 0 skipped; Turso/memory service, formatter, scheduler contract, and command smoke |
| 2026-07-15 | `node --check` Birthday modules and `index.js` | Pass |
| 2026-08-30 | `node --test` across all suites after sticker modularization and canvas removal | 274 pass, 0 fail, 0 skipped; 57 suites |
| 2026-08-30 | `node --test test/stickerModularServices.test.js test/stickerModuleLoad.test.js` | 8 pass, 0 fail, 0 skipped; SVG text/meme/quote/emoji/template rendering & QR SVG generation verified |
| 2026-08-30 | `node --test` across all suites after Selfbot / Multi-Session implementation | 291 pass, 0 fail, 0 skipped; 62 suites |

The local runtime, Turso initialization, one fixed-process scheduled Reddit sticker delivery, and one isolated direct Reddit generation/send were verified. Discovery now targets multiple meme/comedy subreddits, rejects removed/deleted/generic shell results, rejects known over-limit videos, and scheduled delivery also skips historical photo-only rows. Koyeb remains stopped and was not redeployed.

---

## Known Limitations

| Limitation | Status |
|---|---|
| Koyeb deployment health after this migration | Not verified |
| Live WhatsApp scheduled-delivery smoke test | Verified locally: one generated Reddit sticker was sent after the next five-minute tick |
| Live News + Groq + You.com scheduled run | Not verified |
| Live FX provider and Turso reconnect retry | Not verified |
| Full process restart can discard pending News/Reddit in-memory delivery | Known limitation |
| Historical low-quality `ready` rows from earlier smoke tests remain in Turso for audit; sender quality gate excludes photo-only non-meme metadata | Known limitation |
| Birthday media assets in the current checkout | Optional files are absent; production falls back to text and `BIRTHDAY_SONG_URL` unless assets are bundled |
| Koyeb Birthday scheduler health | Not verified in this session; requires deployment and log/WhatsApp smoke test |
| Graphify diagnostic reported 65 dangling-endpoint edges and 166 collapsed endpoint pairs in the orientation graph | Graph artifact warning; source and tests were used for final technical conclusions |

---

## Next Safe Action

Verify the tracked Koyeb deployment commit, startup logs, `/health`, Baileys connection-open log, and one scheduled or controlled live send inside the active WIB window.
