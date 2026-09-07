# Infrastructure audit — findings and adversarial review

> Audited 2026-08-10. Scope: `src/worker.js`, `wrangler.jsonc`, `schema.sql` + `migrations/`,
> `public/_headers`, `public/sw.js`, `public/outbox.js`, `package.json`, `docker-compose.yml`, `.gitignore`.
> Method: direct audit, then an independent adversarial pass that verified every finding against
> the code (verdicts inline), hunted for missed issues, and critiqued each proposed fix.
> Nothing has been changed — this document is findings only.

## TL;DR

Two findings matter now, both **confirmed** by the adversarial pass:

1. **S1 — the schedule endpoint is effectively public.** `GET /api/team/<any 8+ chars>/schedule`
   returns the GameChanger calendar (kids' game times and locations) to anyone who knows the app URL:
   `gate()` allows nonexistent teams and `getSchedule()` ignores the team id entirely.
2. **C2 — every remote-migration instruction in the repo is broken** under an OAuth token (the
   D1 `/import` path, bug-140/141), not just `npm run db:init` — the migration files' own header
   comments point at the same broken `--remote --file` path. Fix: adopt `wrangler d1 migrations apply`
   (verified to use the working `/query` path), **but seed `d1_migrations` first** or the first run
   dies on duplicate-column ALTERs against the already-migrated prod DB.

Everything else is medium-or-below. Overall the infrastructure is in good shape for what it is:
secrets handling, CSP, cookie flags, team-scoped SQL, and idempotent sync are all done right
(S6 below), and DRY debt is deliberately low.

---

## Security

### S1 — Schedule endpoint is effectively unauthenticated — **HIGH · CONFIRMED**

`getSchedule(env, request)` ([worker.js:546](../src/worker.js#L546)) never receives the team id —
the router discards it ([worker.js:90](../src/worker.js#L90)) — and serves the single global
`GC_ICS_URL` feed. `gate()` returns *allow* when the team row doesn't exist
([worker.js:251](../src/worker.js#L251)). Net: any request shaped
`/api/team/AAAAAAAA/schedule` gets the coach's family schedule. The edge cache
(`cacheTtl: 1800`) makes this a pure disclosure bug, not a GC-hammering bug — but the
disclosure is a child's whereabouts, hence High.

**Fix (adversarially lazified):** require the team row to exist before serving the schedule —
one `SELECT 1 FROM teams WHERE id = ?` in `getSchedule` (or make `gate()` 404 on missing rows
for this route). The originally proposed env-var team allowlist was judged over-engineered:
row-existence is the minimum that actually closes the hole, since real team ids are 128-bit
random hex and unguessable.

### S2 — Unauthenticated resource creation, no write quota — **MEDIUM (downgraded) · CONFIRMED, severity trimmed**

`PUT /api/team/:id` upserts a row for any conforming id (512 KB doc each); event/appearance
batches are capped at 500 rows but batch count is unlimited; `POST .../alarm` arms a Durable
Object for any name. An attacker who learns the URL can burn D1 free-tier storage and DO quota.
The adversarial pass trimmed the severity: no amplification exists, and the failure mode is
availability (D1 write errors), not data compromise. **Decision: accept the risk consciously**
(obscure URL, one user); a Cloudflare WAF rate rule is the escape hatch if it's ever abused.
No in-app CAPTCHA machinery.

### S3 — Push endpoint SSRF-lite — **LOW · CONFIRMED · accept**

`postPushSub` accepts any `https:` endpoint ([worker.js:640](../src/worker.js#L640)); the DO
alarm later POSTs to it. Blind POST, empty body, response unused, VAPID header exposes only the
public key, and Workers `fetch` can't reach RFC1918. Accept as-is.

### S4 — PBKDF2 at 10k iterations — **ACCEPTED TRADEOFF · one correction**

Documented Workers-Free CPU-budget decision; the iteration count lives inside the hash so it can
be raised later at zero cost. **Correction from the adversarial pass:** the compensating
`LOGIN_LIMIT` rate limit counts **per-colo**, not globally — a distributed guesser gets 10/min
*per data center*. Still not a practical break against a 6+ char passphrase behind an
unguessable team id, but don't over-credit the limiter in future reasoning.

### S5 — No HSTS header — **INFO**

`workers.dev` is HSTS-preloaded, so this is a non-issue today. It becomes a real one-line to-do
in `public/_headers` the day the custom domain (F4) lands.

### S6 — What's already right (verified)

- `.dev.vars` never committed (checked full git history); `.gitignore` covers it.
- `redact()` guards both error paths that could echo the GC bearer URL.
- CSP allows no external origins, no inline script; `'unsafe-inline'` on style-src only.
  (Nit: the CSP covers the static app only — API JSON responses set `nosniff` but no CSP;
  not exploitable, just don't over-claim.)
- Cookie flags correct: `HttpOnly; Secure; SameSite=Strict; Path=/api`.
- Constant-time comparison for both password hashes and session HMACs.
- Every archive write is team-scoped via `EXISTS`/`JOIN` — one team's token cannot write
  into another team's archive.

### M2 (found by adversarial pass) — First-passphrase lockout — **LOW · document, don't fix**

Anyone holding the link can set the *first* passphrase ([worker.js:294](../src/worker.js#L294))
and lock the coach out. Semi-by-design (link = credential; recovery is a one-line D1 `UPDATE`
via the working `--command` path). The real implication: the passphrase protects against a link
leaked *in the past*, not against an attacker who acts the moment they get the link. Known
limitation, now stated.

---

## Correctness / operations

### C1 — `putTeam` optimistic concurrency is TOCTOU-racy — **MEDIUM · CONFIRMED**

`SELECT rev` then unconditional upsert ([worker.js:128-156](../src/worker.js#L128-L156)): two
in-flight writers reading rev=5 both pass the `baseRev` check and both write rev=6 — one edit
silently lost, the exact failure `rev` exists to flag. **Fix (verdict: correct and lazy, ship
it):** `UPDATE teams SET ... WHERE id = ? AND rev = ?`, check `meta.changes === 1`, INSERT only
when no row. No transaction, no DO.

### C2 — Remote migrations are broken end-to-end; state untracked — **HIGH · CONFIRMED, broadened**

Known: `npm run db:init` uses `--remote --file` → the D1 `/import` path that fails under an
OAuth token (code 10000; this is how prod once ran with 4 missing tables — bug-140/141).
**Broadened by the adversarial pass:** the migration files' own header instructions
([0001](../migrations/0001_games_venue.sql), [0002](../migrations/0002_teams_pass.sql)) use the
same broken path — every documented remote-migration route fails.

**Fix — verified viable:** adopt `wrangler d1 migrations apply`. The adversarial pass traced
wrangler's source: `migrations apply` sends each migration as a *command* through the working
`/query` API path, not `/import` — so it resolves the exact auth failure. Plan:

1. **Seed `d1_migrations` on the remote DB first** (via `--command`, which works) marking
   0001/0002 as applied — otherwise the first `apply` re-runs the ALTERs against the
   already-migrated prod DB and dies on `duplicate column name`. ⚠️ This landmine was missed
   in the original draft.
2. Fold `schema.sql` into `migrations/0000_init.sql` (idempotent — all
   `CREATE TABLE IF NOT EXISTS`).
3. Delete `db:init` / `db:init:local`; replace with `wrangler d1 migrations apply
   coach-sideline-db --local|--remote`.
4. Update the header comments in the migration files.

### C3 — No pre-deploy test gate — **MEDIUM · CONFIRMED**

115 tests pass (`node --test`, run during this audit) but `deploy` is bare `wrangler deploy`.
**Fix:** `"deploy": "node --test && wrangler deploy"`. No CI platform needed for a solo project.

### C4 — No backup beyond D1 Time Travel — **LOW · CONFIRMED**

A season outlives the Time Travel retention window. **Fix:** a documented periodic
`wrangler d1 export` (export is unaffected by the OAuth `/import` bug). Don't build a backup
service.

### C5 — Standing dev tunnel — **LOW · CONFIRMED**

`docker-compose.yml` runs cloudflared with `restart: unless-stopped` and mounted credentials —
the tunnel auto-resurrects on every Docker start and exposes whatever the local ingress points
at (an unauthenticated dev server + dev D1). **Fix:** `restart: "no"`; start it by hand when
actually needed.

### M3 (found by adversarial pass) — DO alarm retry storm — **LOW**

`GameClock.alarm()` ([worker.js:691](../src/worker.js#L691)) has no outer try/catch. Per-endpoint
`sendPush` is guarded, but the `DELETE FROM push_subs` prune is not — if that D1 write throws,
the alarm throws, and the DO runtime *retries the alarm*, re-notifying every phone. Also
`{at:0}` cancels the alarm but never clears the stored `team` key (harmless). **Fix:** wrap the
alarm body in try/catch.

### M5 (found by adversarial pass) — Outbox appearance frac edge — **LOW · note only**

`Outbox.flush` correctly re-reads localStorage after every `await` (the bug-060 lesson holds).
Remaining edge: appearances are cleared by key after POST, so a `frac` updated for the *same*
key while its POST was in flight is dropped unsent. Rare and self-healing on the next
appearance write for that key. Games/events paths are clean.

---

## Optimization

Scale is ~one team; there are no performance problems worth engineering. Two notes:

- **O1:** `gate()` + `getTeam` double-read the same `teams` row (two PK lookups per call).
  Could be one query; at this scale, note only.
- **O2 (real cost — toil, not perf):** the service-worker shell cache needs a manual `CACHE`
  bump on every shell change (now v15), and the mixed-stale-shell failure mode (bug-151) has
  recurred. Accepted consequence of the no-build-step design; the discipline *is* the fix.

## DRY

Debt is low and appropriate to the plain-scripts design. Worth doing (pure dedup, zero
abstraction cost):

- **D1:** `env.coach_sideline_db || env.DB` appears 3× → one `db(env)` helper.
- **D2:** the `try { await request.json() } catch` block appears 8× → one `readJson(request)`.

Not worth doing: **D3** (merging `getPositions`' two near-identical queries — the conditional
SQL is uglier than the duplication), and any router/framework. Adversarial pass concurs on all
three.

## Missing / shallow features (infra-adjacent)

- **F1 — No read-only share.** The team id IS the write credential; there is nothing safe to
  give a parent. Needs `view_token` + read-only endpoints before any parent-facing share
  (already flagged in project memory). Biggest product-shaped gap.
- **F2 — Schedule is single-tenant.** One global `GC_ICS_URL` for all teams; blocks ever
  having a second team. Fold into the S1 fix whenever multi-team matters.
- **F3 — No error alerting.** Observability logs exist; nothing notifies on 500s or failed
  pushes. Optional: a Cloudflare notification on error rate.
- **F4 — Custom domain undecided (sharpest strategic point).** PWA installs and push
  subscriptions are **origin-bound** — migrating from `workers.dev` to a custom domain later
  forces every device to reinstall and re-subscribe. Decide the domain **before** wider rollout;
  the route line in `wrangler.jsonc` is already written, commented out.

---

## Adversarial review — summary of what it changed

The independent pass verified every finding against the code with file:line evidence. Deltas:

| Draft claim | Verdict | Change |
|---|---|---|
| S1 schedule leak, High | CONFIRMED | Fix lazified: row-existence check, not env allowlist |
| S2 storage abuse, Medium | CONFIRMED, trimmed | Reframed as availability/cost, not compromise; accept |
| S4 "compensated by 10/min limit" | Corrected | Limit is per-colo, not global — weaker than claimed |
| C2 fix via `d1 migrations apply` | **Verified viable** (traced wrangler source: uses `/query`, not the broken `/import`) | Added the ⚠️ M1 landmine: seed `d1_migrations` first or the first apply fails on prod |
| "12 test files" | Corrected | 115 tests, all passing at audit time |
| S6 "tight CSP" | Nit | CSP covers static app only, not API responses (not exploitable) |

New issues it found: **M2** (first-passphrase lockout — documented limitation), **M3** (DO alarm
retry storm — wrap in try/catch), **M5** (outbox frac edge — note only), plus the **M1**
migrations landmine above. All fix critiques adopted; nothing in the draft was judged WRONG.

## Recommended order of work (laziest first)

1. **S1** — one existence query in `getSchedule`. Closes the only High security hole.
2. **C3** — one line in `package.json`. Tests now gate deploys.
3. **M3** — try/catch around `alarm()`. Prevents notification storms.
4. **C1** — conditional UPDATE in `putTeam`. Closes the lost-write race.
5. **C2** — migrations overhaul (seed `d1_migrations` → `0000_init.sql` → switch scripts).
   The biggest item, and the one with the prod landmine — follow the four steps in order.
6. **C5** — `restart: "no"` in docker-compose.
7. **D1/D2** — the two helpers, next time the worker is open anyway.
8. **F4** — decide the custom domain before handing the link to more devices.
