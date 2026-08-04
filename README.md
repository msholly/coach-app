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
npm run db:init                              # applies schema.sql to the REMOTE D1
npm run deploy
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
npm run db:init:local     # applies schema to a local (miniflare) D1
npm run dev               # wrangler dev — open the printed http://localhost:PORT
```

## Test

```bash
npm test                  # node --test — worker API: create/read/conflict/force/validation
```

## How sync resolves conflicts

Designed for **one coach editing at a time** (the normal case). Writes carry the revision
they were based on; if the server has moved on, the server returns **409** and the app asks
you to choose: *use the other device's version* or *overwrite with this one*. No silent data
loss. Pulls that find a newer server revision adopt it and re-render.

## Data & privacy

- The team token in the URL is a **secret capability link** (like a "anyone with the link"
  doc). Treat it as the password. It's the only gate in v1.
- It's kids' data — keep entries to **first name + last initial**. A passphrase gate is an
  easy future add (`teams.pass_hash` column + check in the Worker).
- **Backups are automatic:** D1 **Time Travel** keeps 30 days of point-in-time history —
  restore with `npx wrangler d1 time-travel restore coach-sideline-db --timestamp=<ISO>`.

## Files

| File | What |
|------|------|
| `public/index.html` | The whole app + the local-first sync client (single file). |
| `src/worker.js` | Serves the app (ASSETS binding) + the `/api/*` JSON API over D1. |
| `schema.sql` | The one `teams` table. |
| `wrangler.jsonc` | Worker config: static assets, `run_worker_first` for `/api/*`, D1 binding. |
| `test/worker.test.mjs` | API unit tests (mock D1). |

## API

- `GET /api/health` → `{ ok, app:"coach-sideline" }` (frontend backend-detection)
- `GET /api/team/:id` → `{ id, doc, rev, updatedAt }` or 404
- `PUT /api/team/:id` body `{ doc, baseRev }` → `{ id, rev, updatedAt }`; **409** on stale
  `baseRev` (returns current doc) unless `?force=1`. `id` = `[A-Za-z0-9_-]{8,64}`; `doc` must
  be a JSON string ≤ 512 KB.
