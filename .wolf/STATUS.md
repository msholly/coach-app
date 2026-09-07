# STATUS — coach-sideline

> Single source of truth for resuming work. Read this FIRST when starting a session.
> Update this file at the end of every work phase so the next `/clear` resumes in 1 read.
> Last updated: 2026-09-05

---

## ✅ Done

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
1. `npm run db:migrate:local` and `npm run db:migrate` apply `0001_snacks.sql` (ALTER + 2 CREATE) without error.
2. Coach taps 🍊 on the Roster tab, gets `/snacks#b=…`, parents can take/change/give back a game on their phones.
3. If a second team is added: 📅 Connect schedule with that team's GC "Subscribe to calendar" link; its board shows only its games.

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
- Should the coach app show the signup list (a card on Season or Roster)? API exists; UI deferred.
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
