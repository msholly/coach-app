# STATUS — coach-sideline

> Single source of truth for resuming work. Read this FIRST when starting a session.
> Update this file at the end of every work phase so the next `/clear` resumes in 1 read.
> Last updated: 2026-09-07

---

## ✅ Done

### Season archive — graphical game replay + persist lu.iv — 2026-09-13
- Expanding a game on the Season tab now shows a per-player interval-track grid (the same bars Game Day draws live) above the text log: where inside each period each player's minutes fell, position per period, ⚽ goal markers, opponent-goal row. `gameTracksHtml` (app.js) reuses `trackHtml` with `{Q,iv}` + `api=Q,pt=0`; light-on-dark palette `.gtrk-*` (app.css).
- **Kept all generated data (user pref):** `migrations/0005_games_iv.sql` adds `games.iv` (JSON interval ledger). `queueGameRow` archives `iv:lu.iv`; `postGame` stores it (`COALESCE(excluded.iv,games.iv)`); `GET /games/:gid` now returns `{events,appearances,iv}`. Past games without iv reconstruct from appearances+events via `ArchiveStats.reconstructIv` (frac is authoritative; sub `secs` place partial runs).
- Also fixed: Season archive "No events recorded" empty-cache bug (`toggleLogGame` refetches when cached events [] OR appearances absent) + sw v20→**v22**.
- **Adversarial-review hardening (2026-09-13):** practice games buffer their event log in `g.plog` and drain to the outbox on practice→real conversion (no more lost subs/goals — bug-187); outbox game-row + appearance drains race-guarded (bug-188); `ivClose(cap)` clips iv on an early finish (bug-189); iv cap 40k→200k, `games.roster` snapshot (migration **0006**) so renames don't rewrite history, position swaps now log a `swap` event (bug-190). Suite **166/166**; `reconstructIv` verified vs real 9/12 data; migrations 0005+0006 apply local.
- **NOT deployed / NOT migrated remote / 9/12 iv NOT backfilled** — see 🚀 Next phase. Prepared: `scratchpad/iv912.json` (the 9/12 iv to backfill). **Rollout order: migrate 0005+0006 FIRST, THEN deploy the worker** (postGame/getGameEvents reference the new columns unconditionally).

### Convert a played 🧪 Practice game → real (backfill records) — 2026-09-13
- Problem: a game started as Practice that should have counted couldn't be made to count after full-time — `game.test` gated every write path and `closeGameRow` is `endedAt`-guarded, so flipping the picker wrote nothing back.
- Fix: `pickGame` (`public/app.js`) now detects a **played** game converting practice→real (`wasTest && !g.test && g.gid && g.startedAt && state.lineup`) and backfills `queueGameRow()` + `queueAppearances(...)` (idempotent, keyed), then `flushOutbox()`. Career ledgers (`played`/`kept`) are intentionally NOT committed here — `commitGame` banks them at the next lineup build, so committing now would double-count. `sw.js` → **v19** (shell file changed).
- Coach action: Roster tab → "This game" picker → pick the scheduled game (or ✏️ Real game — not on the list). Season stats/appearances backfill immediately; career playing-time credit banks when you build your next game's lineup. Suite **152/152**. NOT committed at time of writing.

### Game Day pulls from the schedule + practice/test games — 2026-09-07
- **"This game" picker (Roster tab, `#gameSel`):** 🧪 Practice / an optgroup of upcoming scheduled games (from the GC feed) / ✏️ manual real game. `loadSchedule()` fills it from `GET /api/team/:id/schedule`; `renderGamePicker()`/`pickGame()` in `public/app.js`.
- **Linking a scheduled game** sets `g.sched={uid,opponent,startsAt,venue}`, pre-fills Home/Away (still overridable — feed lags), shows the opponent on the scoreboard (`#themName`), and makes the game **count**. `queueGameRow` now archives the opponent (was always NULL).
- **Practice/test game (the default when unlinked):** `state.game.test` gates `logEvent` (outbox only — local undo/goals still work), `queueGameRow`, `queueAppearances`, `commitGame` (career ledgers). Nothing reaches the archive or fairness ledgers. Amber 🧪 badge (`#practiceTag`) on Game Day. Existing games grandfathered as counting (state.js fixup).
- Files: `public/index.html`, `public/app.js`, `public/state.js`, `public/app.css`, `public/sw.js` (**v18** — shell files changed). Tests: `test/state.test.mjs` +3, suite **149/149**. Headless E2E (scratchpad `verify-testgame.mjs`, /api stubbed so no D1 writes): **16/16** — practice writes 0 rows, linked game archives with opponent+venue.
- NOT committed. Static-only change (no worker.js edit, no new migration — `games.opponent` already existed). Deploy = redeploy static assets; the picker's scheduled-games list only appears once a team's GC feed is connected (📅 Connect schedule).

### Referee sign-up per-team toggle (BU5 = off) — 2026-09-07
- `migrations/0003_ref_toggle.sql`: `snack_boards.referees_enabled` (DEFAULT 1). Coach's per-team switch.
- `PUT /api/team/:id/snacks {referees:bool}` (mints board if absent); `getTeamSnacks`+`getBoard` return `referees`; `putRef` → 403 when off. **Off only hides the slot — `ref_signups` rows are kept**, so flipping back on restores volunteers.
- Coach 🙋 **Referee sign-up: On/Off** button (Roster tab); parents' board hides the slot on `d.referees===false`.
- Tests +3 → **Suite 149/149.** VM render check confirms the slot disappears when off. NOT committed; **0003 NOT migrated** yet.

### Coach snack link + refresh games + parent-referee sign-up — 2026-09-07
- **Always-visible snack link (coach):** `showSnackLink()`/`refreshSnackLink()` GET the board on load and render "Open the board ↗" under the 🍊 button — no tap-to-copy needed. `public/app.js`.
- **Refresh games (coach ↻ button):** `loadCalendar(raw,{fresh})` sets `cache:"no-cache"` → Cloudflare revalidates with GC and **replaces the shared cache the parents' board reads**, so a just-changed game shows immediately (not just for the coach). `GET /schedule?fresh=1` + games count; button on the Roster tab toasts the count.
- **Parent-referee sign-up (parents' board, home games only):** `migrations/0002_referees.sql` (`ref_signups`, claim-guarded like snacks, name-only). Public routes `PUT/DELETE /api/snacks/:board/:uid/ref` (venue=home enforced, same rate-limit key). `getBoard` adds a `referee` field per home event. `snacks.js` role-aware (snack + ref slots), `snacks.css` `.sn-ref` neutral chip, `snacks.html` copy updated.
- Tests: `test/snacks.test.mjs` +5 (referee home-only, claim guard, validation/rate-limit, refresh count). **Suite 146/146.**
- NOT committed. **`0002_referees.sql` NOT migrated** on local/remote D1 yet (user runs it). Not live-screenshotted (needs the migration + a live GC feed).

### Snack sign-up (parents' public board) — 2026-09-05
- `migrations/0001_snacks.sql`: `snack_boards` (one public link per team), `snack_signups` (one family per game, claim-guarded), `teams.ics_url` (per-team GameChanger feed).
- Worker: `GET/POST /api/team/:id/snacks`, `DELETE /api/team/:id/snacks/:uid` (gated, coach side); `GET /api/snacks/:board[?claim=]`, `PUT/DELETE /api/snacks/:board/:uid` (public, own capability, rate-limited per board+IP); `PUT /api/team/:id/schedule {url}` per-team feed. `loadCalendar(url)` shared by schedule + board.
- Parents' page `public/snacks.html|css|js` at `/snacks#b=<board>`; coach buttons **🍊 Snack sign-up link** and **📅 Connect schedule** on the Roster tab.
- `sw.js` v17: navigations to anything but `/` bypass the shell cache.
- Tests: `test/snacks.test.mjs` (20). Suite 141/141. Live smoke on a throwaway D1 + headless-Chrome walk of the sign-up flow — passed.
- NOT committed. NOT migrated on the user's dev/remote D1 (see ⚠️).

---

## 🚀 Next phase

**Goal:** ship the snack sign-up — migrate, deploy, hand the link to parents.

### Acceptance criteria
1. `npm run db:migrate:local` and `npm run db:migrate` apply `0001_snacks.sql`, `0002_referees.sql` AND `0003_ref_toggle.sql` without error.
2. Coach taps 🍊 on the Roster tab, gets `/snacks#b=…`, parents can take/change/give back a game AND volunteer to referee home games on their phones. Coach can turn referee sign-up off (BU5) with 🙋 — the slot hides, volunteers are kept.
3. Coach ↻ Refresh games pulls the latest GC schedule immediately (bypasses the 30-min cache) and the parents' board reflects it.
4. If a second team is added: 📅 Connect schedule with that team's GC "Subscribe to calendar" link; its board shows only its games.

### Files to create / edit
| Type | File | Content |
|---|---|---|
| maybe | `public/index.html` / `app.js` | coach-side list of who signed up (GET /api/team/:id/snacks already returns it; no UI yet) |
| maybe | `public/snacks.js` | "remind me" / share button; per-game snack suggestions |

### Closed decisions
- Board id is a second capability, never the team token (see cerebrum Decision Log 2026-09-05).
- Ownership = per-browser random `claim`; server never echoes it; coach clears via gated route.
- Games only (practices skipped); feed = `teams.ics_url` else `GC_ICS_URL`.

### Open decisions
- Should the coach app show the signup list (a card on Season or Roster)? API exists; UI deferred. (2026-09-07: coach now gets an always-visible "Open the board ↗" link under the 🍊 button — GET /snacks on load, `showSnackLink()`/`refreshSnackLink()` in app.js. Full who-signed-up list still deferred.)
- Snacks at practices too? Currently excluded.

---

## 📁 Active architecture

- **Stack:** Cloudflare Worker (`src/worker.js`) + D1 + one Durable Object (GameClock alarms) + static PWA in `public/` (plain scripts, no build). Tests: `node --test` with in-memory D1 stand-ins.
- **Key tables:** `teams` (doc JSON, rev, pass_hash, ics_url), `games`, `game_events`, `appearances`, `push_subs`, `snack_boards`, `snack_signups`.
- **Patterns:** team id in URL hash is the capability; `gate()` on every `/api/team/:id*` route; client-generated ids → idempotent writes; `redact()` on every error path; CRLF files: `index.html`, `README.md`.

---

## ⚠️ External blockers (don't block coding)

- Migration `0001_snacks.sql` must be applied to the user's local dev D1 and to remote (**user runs it** — DB policy: environment must be named).
- Uncommitted pre-existing work on `main` (tracks `origin/master`, ahead 3): app.js/lineup-core.js/sw.js edits, docs, `.wolf` churn. Snack work is mixed into the same tree.

---

## 🔧 Useful commands

```bash
node --test                          # 141 tests
npm run dev                          # wrangler dev (check for orphan workerd first!)
npm run db:migrate:local             # apply migrations/ to local D1
npm run db:migrate                   # apply to remote
# throwaway D1 for a schema trial: copy wrangler.jsonc with a new database_id, use -c on both
# `d1 migrations apply` and `dev`; delete the config + the new .wrangler/state/v3/d1/*.sqlite after
```

---

## 📚 References (read IF needed)

- `.wolf/cerebrum.md` — User Preferences + Do-Not-Repeat + Decision Log
- `.wolf/anatomy.md` — token-efficient file index
- `.wolf/buglog.json` — known bugs + fixes (bug-177..180 from this session)
