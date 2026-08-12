# Coach's Sideline — Cloudflare (Workers + D1)

The U8 AYSO coaching app (roster/lineup, practice builder, drill library, game-day
dashboard) hosted on **your** Cloudflare account, with **local-first cross-device sync**.

- **One JSON document per team**, stored in **D1** (serverless SQLite), keyed by an
  unguessable token that lives in the share URL (`…/#t=<token>`).
- **Local-first:** the browser works entirely offline against `localStorage`; it pushes
  changes when online (debounced) and pulls on load / tab-focus / reconnect. The backend
  is a sync + backup layer, never a hard dependency — so a dead signal at the field never
  bricks game day.
- **Same file, two modes:** if there's no backend (e.g. opened as a plain file or a Claude
  Artifact), it silently runs local-only. Point it at this Worker and it syncs.

## Deploy (once)

```bash
npm install
npx wrangler login
npx wrangler d1 create coach-sideline-db     # copy the printed database_id ...
#   ... paste it into wrangler.jsonc  ->  d1_databases[0].database_id
npm run db:migrate                           # applies migrations/ to the REMOTE D1
npm run deploy                               # runs the tests, then wrangler deploy
```

Then put it on your domain (`coach.mitchellsholly.com`): easiest is the dashboard —
**Workers & Pages → coach-sideline → Settings → Domains & Routes → Add → Custom Domain**.
(Or uncomment the `routes` line at the bottom of `wrangler.jsonc` and `npm run deploy` again;
Cloudflare creates the DNS record for you, since the zone is already on Cloudflare.)

Open the URL once — it mints a team, seeds your roster, and updates the address to
`…/#t=<token>`. Tap **Copy team link** and open that link on your phone and any assistant
coach's phone. Same link = same synced team.

## Local dev

```bash
npm run db:migrate:local  # applies migrations/ to a local (miniflare) D1
cp .dev.vars.example .dev.vars   # then fill in — .dev.vars is gitignored
npm run dev               # wrangler dev — open the printed http://localhost:PORT
```

`.dev.vars` is only read at **startup** — restart `wrangler dev` after editing it.

## Schema migrations

Migrations live in `migrations/` and are applied with the D1 migrations framework, which
sends each statement through the working `/query` API path — **not** the `--file`/`/import`
path that fails under a `wrangler login` (OAuth) token with `Authentication error [code: 10000]`.

```bash
npm run db:migrate:local   # wrangler d1 migrations apply ... --local
npm run db:migrate         # wrangler d1 migrations apply ... --remote
```

`migrations/0000_init.sql` is the full schema, all `CREATE TABLE IF NOT EXISTS` — idempotent,
so applying it to an already-provisioned DB is a no-op. A new column is a new numbered file
(`0001_*.sql`, an `ALTER TABLE`); the framework tracks what's applied in a `d1_migrations`
table and only runs the new ones.

> **Adopting the framework on a DB that predates it** (provisioned with the old `db:init`):
> the remote already has every table and column, so `apply` must not re-run anything. Seed the
> tracking table first — `--command` works with an OAuth token where `--file` does not:
>
> ```bash
> # 1. confirm what's really there (bug-140 history: don't assume)
> npx wrangler d1 execute coach-sideline-db --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
> # 2. create + seed the tracker so 0000 is marked applied and never re-runs
> npx wrangler d1 execute coach-sideline-db --remote --command="CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp); INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0000_init.sql')"
> # 3. now this is a clean no-op, and future migrations apply normally
> npm run db:migrate
> ```
>
> (0000 is all `CREATE TABLE IF NOT EXISTS`, so even an un-seeded re-run is harmless — the seed
> just keeps `migrations list` honest. It's the ALTER files in *future* migrations that would
> fail on a double-apply, which is what the tracker prevents.)

## GameChanger schedule (optional, read-only)

GameChanger publishes a per-team **ICS subscription feed** — the only integration point it
offers; there is no write API. `GET /api/team/:id/schedule` proxies it and returns parsed
events, including `venue` (`"home"`/`"away"`/`null`) and `opponent` derived from the event
summary (`Team vs X` = home, `Team @ X` = away; anything else stays `null`).

```bash
npx wrangler secret put GC_ICS_URL     # production
# local: GC_ICS_URL=... in .dev.vars
```

**The feed URL's `token` parameter is a bearer credential** — anyone holding the URL can read
the team's schedule. It lives only in the secret, is used only server-side, and never reaches
the browser or the repo. Every error path runs through `redact()` so a failed subrequest
cannot echo it back. Rotate it by re-subscribing in GameChanger.

Note: GC advertises `X-PUBLISHED-TTL` of 5 hours and the feed lags edits made in the app, so
treat it as a planning aid, not a game-morning source of truth. The manual **This game**
selector on Roster & Lineup stays authoritative.

## Test

```bash
npm test                  # node --test — worker API: create/read/conflict/force/validation
```

## How sync resolves conflicts

Designed for **one coach editing at a time** (the normal case). Writes carry the revision
they were based on; if the server has moved on, the server returns **409** and the app asks
you to choose: *use the other device's version* or *overwrite with this one*. No silent data
loss. Pulls that find a newer server revision adopt it and re-render.

## Login (optional team passphrase)

The team token in the URL is a **secret capability link** — whoever holds it holds the team.
That's right for a link you text to two assistant coaches, and wrong the moment it leaks, so
a team can add a passphrase on top of it.

- **Opt-in, per team.** No passphrase = the link is the only gate, exactly as before. Nobody's
  existing link stops working.
- Set it from **Roster & Lineup → 🔓 Add a passphrase**, next to *Copy team link*. Everyone who
  opens the link types it once per device; the session lasts 30 days.
- **One shared passphrase per team. No accounts, no email, no reset** — there's no address to
  send one to. Changing it signs out every device (see below), which is the revocation path.
- **Forgot it?** Your own phone still holds the whole team in `localStorage`; only sync stops.
  Unlock it by hand:
  ```bash
  npx wrangler d1 execute coach-sideline-db --remote \
    --command="UPDATE teams SET pass_hash = NULL WHERE id = '<token>'"
  ```

How it's stored and checked:

| | |
|---|---|
| **Hash** | PBKDF2-SHA256, 16-byte random salt, `pbkdf2$iters$salt$hash`. 10,000 iterations — Workers **Free allows 10 ms CPU per request** and PBKDF2 costs ~0.5 ms per 1,000. The count lives in the hash, so raising it on a paid plan re-hashes nobody. |
| **Session** | Signed cookie, `HttpOnly; Secure; SameSite=Strict; Path=/api`, 30 days. The signing key **is the team's `pass_hash`** — so there's no session secret to manage, and changing the passphrase invalidates every outstanding session everywhere, for free. |
| **Brute force** | The `LOGIN_LIMIT` rate-limit binding: 10 attempts/minute, keyed on the **team id** (an IP key just invites a guesser to rotate IPs). Checked before any D1 read or key derivation. |
| **Gate** | Every `/api/team/:id*` route except `/auth` itself. Comparisons are constant-time. |

## Security headers

`public/_headers` (native to Workers static assets) sets CSP, `nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Permissions-Policy` and COOP on the app shell; `/api/*` responses
add `nosniff` in `src/worker.js`. The CSP allows **no external origins and no inline scripts**;
`'unsafe-inline'` is on `style-src` only, for the `style=""` attributes in `index.html`.

## Data & privacy

- It's kids' data — keep entries to **first name + last initial**.
- **Backups are automatic:** D1 **Time Travel** keeps 30 days of point-in-time history —
  restore with `npx wrangler d1 time-travel restore coach-sideline-db --timestamp=<ISO>`.
- **A season outlives 30 days**, so export a full snapshot at least once a season (export uses
  a working API path; the `/import` OAuth bug does not affect it):
  ```bash
  npx wrangler d1 export coach-sideline-db --remote --output=backup-$(date +%Y%m%d).sql
  ```

## Files

| File | What |
|------|------|
| `public/index.html` | The whole app + the local-first sync client (single file). |
| `src/worker.js` | Serves the app (ASSETS binding) + the `/api/*` JSON API over D1. |
| `migrations/` | D1 schema; `0000_init.sql` is the full schema, applied via `db:migrate[:local]`. |
| `wrangler.jsonc` | Worker config: static assets, `run_worker_first` for `/api/*`, D1 binding. |
| `test/worker.test.mjs` | API unit tests (mock D1). |

## API

- `GET /api/health` → `{ ok, app:"coach-sideline" }` (frontend backend-detection)
- `GET /api/team/:id` → `{ id, doc, rev, updatedAt }` or 404
- `PUT /api/team/:id` body `{ doc, baseRev }` → `{ id, rev, updatedAt }`; **409** on stale
  `baseRev` (returns current doc) unless `?force=1`. `id` = `[A-Za-z0-9_-]{8,64}`; `doc` must
  be a JSON string ≤ 512 KB.
- `GET /api/team/:id/auth` → `{ exists, locked, authed }` — what the client needs to decide
  whether to prompt.
- `POST /api/team/:id/auth` — `{ pass }` log in · `{ newPass }` set/change · `{ pass, newPass }`
  change without a live session · `{ newPass: null }` remove. **200** sets the session cookie,
  **401** `bad_passphrase`, **429** rate limited, **404** team doesn't exist yet.
  Setting the *first* passphrase only needs the link; changing it needs a session or the current
  passphrase. Every other `/api/team/:id*` route answers **401** `{error:"locked"}` without one.
- `GET /api/team/:id/schedule` → `{ calendar, events:[{ uid, startsAt, endsAt, summary,
  location, description, venue, opponent }] }`. **501** when `GC_ICS_URL` isn't set, **502**
  if the feed is unreachable or isn't a calendar. Never returns the feed URL or its token.
