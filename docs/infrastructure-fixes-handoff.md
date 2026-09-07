# Handoff — infrastructure audit fixes

> Source: [infrastructure-audit.md](infrastructure-audit.md) (2026-08-10, adversarially reviewed).
> Each group below is independent and shippable on its own. Do them in order — earlier groups
> are higher value per line. Finding IDs (S1, C1, …) refer to the audit doc.

## Ground rules (apply to every group)

- This is an OpenWolf project: read `.wolf/OPENWOLF.md`, check `.wolf/cerebrum.md` (especially
  Do-Not-Repeat) before coding, log fixed bugs to `.wolf/buglog.json`.
- **Never run `git commit`** — stage and print the commit command for the user (see the user's
  git-commit-policy rule).
- **Remote D1 is production.** Only Group 4 touches it, and only with the explicit commands
  listed there. Everything else is local-only.
- Verification is not optional: reproduce → fix → re-run the reproduction. `npm test`
  (`node --test`) must pass — baseline is **115/115** as of the audit.
- Windows gotcha (bug-125): before trusting any local server verification,
  `Get-Process workerd | Stop-Process -Force` — orphaned workerd processes serve stale bundles.
- Never write `.wolf/*.json` with PowerShell (BOM corrupts them) — use Write/Edit tools.

---

## Group 1 — Security hotfix (S1 + M3) · ~20 lines, do first

**S1: close the public schedule endpoint.** `src/worker.js`
- `getSchedule(env, request)` currently ignores the team id and `gate()` allows nonexistent
  teams, so `GET /api/team/<any 8+ chars>/schedule` serves the GC calendar to anyone.
- Fix: pass `db` and `id` into `getSchedule`, and before fetching the feed run
  `SELECT 1 FROM teams WHERE id = ?` — return `json({error:"not_found"}, 404)` when absent.
  Do NOT add an env-var allowlist (adversarial review rejected it as over-engineered).

**M3: stop the DO alarm retry storm.** `src/worker.js`, `GameClock.alarm()`
- The `DELETE FROM push_subs` prune is outside the per-endpoint try/catch; if it throws, the
  whole alarm throws and the DO runtime retries → duplicate "Period over" pushes to every phone.
- Fix: wrap the entire `alarm()` body in try/catch (log-and-swallow). While there: clear the
  stored `team` key when `{at:0}` cancels (`this.ctx.storage.delete("team")`) — tidiness only.

**Verify:**
- New tests in `test/worker.test.mjs` (or a small new file, following its in-memory D1 stub
  pattern): schedule with unknown team id → 404; schedule with existing team id → still works.
  Note cerebrum bug-117: any test hitting `worker.fetch` needs a DB stub in env because
  `gate()` runs `db.prepare()` first.
- `npm test` — all green, no regressions.

---

## Group 2 — Deploy hygiene (C3 + C5 + C4) · 3 lines, zero risk

- **C3:** `package.json`: `"deploy": "node --test && wrangler deploy"` — tests now gate deploys.
- **C5:** `docker-compose.yml`: `restart: unless-stopped` → `restart: "no"` — the dev tunnel
  must not auto-resurrect on every Docker start (it exposes the unauthenticated local dev
  server whenever it's up).
- **C4:** add a "Backups" note to `README.md`: run
  `npx wrangler d1 export coach-sideline-db --remote --output=backup-<date>.sql` at least once
  a season (export uses a working API path; the `/import` OAuth bug does not affect it).

**Verify:** `npm run deploy` refuses to deploy when a test fails (temporarily break one to
prove it, then restore); `docker compose up -d` + `docker compose ps` shows the policy.

---

## Group 3 — Lost-write race in sync (C1) · ~15 lines

`src/worker.js`, `putTeam()`:
- Today: `SELECT rev` then unconditional upsert. Two concurrent writers with the same `baseRev`
  both pass the check; one edit is silently lost — defeating the optimistic-concurrency `rev`.
- Fix: replace the blind upsert with a conditional write:
  1. `UPDATE teams SET doc=?, rev=?, updated_at=? WHERE id=? AND rev=?` (expected current rev);
  2. check `meta.changes === 1` on the result;
  3. `changes === 0` and no row exists → INSERT (first write);
  4. `changes === 0` and a row exists → someone won the race: re-read and return the existing
     409 conflict shape `{error:"conflict", id, doc, rev, updatedAt}`.
  Preserve current semantics exactly: `?force=1` and `baseRev:null` (client sent no base) must
  still write unconditionally — implement those as UPDATE-without-rev-guard + INSERT fallback,
  not by keeping the old upsert path.
- **Do not** reach for transactions or a Durable Object — single conditional statement only.

**Verify:** extend `test/worker.test.mjs`: simulate the interleaving (stub returns rev=5 to two
callers; first UPDATE reports changes=1, second changes=0) → second caller gets 409 with the
current doc. Plus regression: fresh-team first PUT, force write, baseRev-null write all still
succeed. `npm test` green.

---

## Group 4 — Migrations overhaul (C2) · the big one · **touches PROD (remote D1: coach-sideline-db)**

Every remote-migration instruction in the repo routes through `--remote --file`, which fails
under an OAuth token (D1 `/import`, code 10000 — bug-140/141). `wrangler d1 migrations apply`
is verified (wrangler source traced) to use the working `/query` path. Migrate to it — **in
this exact order; step 1 before any `apply` or it fails on prod**:

1. **Audit prod state first (read-only):**
   `npx wrangler d1 execute coach-sideline-db --remote --command="SELECT name FROM sqlite_master WHERE type='table'"`
   and check for the `venue` column (`PRAGMA table_info(games)`) and `pass_hash`
   (`PRAGMA table_info(teams)`). Record what actually exists — bug-140 history means you must
   not assume.
2. **Seed the tracking table on prod** (only for migrations the schema shows are ALREADY
   applied) via `--command` (works with OAuth):
   `CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp);`
   then one `INSERT INTO d1_migrations(name) VALUES ('0000_init.sql')…` per already-applied
   file (after step 3 fixes the names). ⚠️ Skipping this makes the first `apply` re-run
   `ALTER TABLE games ADD COLUMN venue` → `duplicate column name` → abort.
3. **Restructure files:** move `schema.sql` → `migrations/0000_init.sql` (contents are all
   `CREATE TABLE IF NOT EXISTS` — idempotent, safe as an init migration). Keep `0001`/`0002`
   as-is but rewrite their header comments to
   `npx wrangler d1 migrations apply coach-sideline-db --local|--remote`. Leave a one-line
   `schema.sql` tombstone or delete it and fix every reference (`README.md`, package.json,
   `.wolf/anatomy.md`, cerebrum's "migrations/ holds ALTER-only follow-ups" entry needs an
   update note).
4. **Scripts:** in `package.json` delete `db:init`/`db:init:local`; add
   `"db:migrate": "wrangler d1 migrations apply coach-sideline-db --remote"` and
   `"db:migrate:local": "wrangler d1 migrations apply coach-sideline-db --local"`.
   (Default `migrations_dir` is `./migrations` — no wrangler.jsonc change needed.)
5. **Apply + verify:** run local apply against a throwaway DB first (cerebrum has the temp-
   config recipe: copy wrangler.jsonc with a different `database_id`, run against it, delete).
   Then `--remote`: expect 0000 to no-op-skip (already seeded) and `migrations list --remote`
   to show all applied. Re-run the step-1 table query and confirm all 5 tables + both columns
   exist on prod.

**Verify:** fresh local DB from zero via `db:migrate:local` boots the app (`wrangler dev`,
create a team, PUT/GET roundtrip); `npm test` green; prod table/column check passes.
Log the whole thing to `.wolf/buglog.json` (it closes the bug-140/141 family) and update
cerebrum's migration entries.

---

## Group 5 — DRY cleanups (D1 + D2) · optional, do while the worker is open anyway

`src/worker.js` only:
- **D1:** `const db = (env) => env.coach_sideline_db || env.DB;` — replace the 3 occurrences
  (two in `fetch`, one in `GameClock.alarm`).
- **D2:** `async function readJson(request) { try { return await request.json(); } catch { return null; } }`
  — replace the 8 `try/catch` blocks; callers return `json({error:"invalid_json_body"}, 400)`
  on null. Watch `postAuth`: `null` body must still 400, and `{newPass: null}` must still be
  distinguishable (it is — that's a non-null object).
- **Explicitly out of scope:** merging `getPositions`' two queries (D3), any router, any
  framework. The adversarial review rejected these.

**Verify:** `npm test` green — behavior-identical refactor, no new tests needed.

---

## Deferred — decisions recorded, NO code (do not "fix" these)

- **S2** storage-abuse surface: accepted risk (availability-only, obscure URL). Escape hatch if
  abused: Cloudflare WAF rate rule. No CAPTCHA, no quotas in app code.
- **S4** PBKDF2 10k iterations: accepted (Workers Free CPU budget); count is stored in-hash and
  can be raised later. Remember the rate limiter is per-colo.
- **M2** first-passphrase lockout: documented limitation, recovery is a D1 `UPDATE` via
  `--command`.
- **F1** parent read-only share (`view_token` + read-only endpoints): real feature work, needs
  its own design pass — not part of this fix batch.
- **F4** custom domain: user decision required. When it lands, add
  `Strict-Transport-Security` to `public/_headers` (S5) in the same change. Flag to the user:
  PWA installs and push subs are origin-bound — decide before wider rollout.
- **O2** service-worker CACHE bump discipline: unchanged; none of these groups touch shell
  files, so no bump is needed for this batch.

## Definition of done (whole batch)

- Groups 1–4 landed (5 optional), each verified as specified, `npm test` ≥ 115 passing.
- Prod D1 confirmed: 5 tables, `venue` + `pass_hash` columns, `d1_migrations` tracking in place.
- `.wolf/buglog.json`, `.wolf/cerebrum.md`, `.wolf/anatomy.md`, `.wolf/memory.md` updated.
- Staged commits (one per group) with printed commit commands — not committed by the agent.
