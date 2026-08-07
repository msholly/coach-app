# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-08-07T16:38:50.336Z
> Files: 91 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.dev.vars` (~134 tok)
- `.dev.vars.example` — Local secrets for `wrangler dev`. Copy to `.dev.vars` and fill in. (~238 tok)
- `.gitignore` — Git ignore rules (~14 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `docker-compose.yml` — Docker Compose services (~145 tok)
- `package-lock.json` — npm lock file (~14099 tok)
- `package.json` — Node.js package manifest (~162 tok)
- `README.md` — Project documentation (~2348 tok)
- `schema.sql` — Database schema (~1055 tok)
- `wrangler.jsonc` (~524 tok)

## .claude/

- `settings.json` (~441 tok)
- `settings.local.json` (~348 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .wrangler/state/v3/cache/miniflare-CacheObject/

- `metadata.sqlite-shm` (~8738 tok)
- `metadata.sqlite-wal` (~2206 tok)

## .wrangler/state/v3/d1/miniflare-D1DatabaseObject/

- `metadata.sqlite-shm` (~8739 tok)
- `metadata.sqlite-wal` (~2206 tok)

## .wrangler/state/v3/do/coach-sideline-GameClock/

- `metadata.sqlite-shm` (~8738 tok)
- `metadata.sqlite-wal` (~30763 tok)

## .wrangler/state/v3/do/coach-sideline-verify-GameClock/

- `metadata.sqlite-shm` (~8738 tok)
- `metadata.sqlite-wal` (~2205 tok)

## .wrangler/state/v3/observability/miniflare-wobs-trace-store/

- `a590acd76969f996ec6e4b599c3c09f58c283a76f2d61392b5d3046caf557602.sqlite-shm` (~8739 tok)
- `metadata.sqlite-shm` (~8738 tok)
- `metadata.sqlite-wal` (~2206 tok)

## .wrangler/tmp/bundle-BVrPiq/

- `middleware-insertion-facade.js` — Exports __INTERNAL_WRANGLER_MIDDLEWARE__ (~199 tok)
- `middleware-loader.entry.ts` — This loads all middlewares exposed on the middleware object and then starts (~1179 tok)

## .wrangler/tmp/bundle-Gms9mH/

- `middleware-insertion-facade.js` — Exports __INTERNAL_WRANGLER_MIDDLEWARE__ (~199 tok)
- `middleware-loader.entry.ts` — This loads all middlewares exposed on the middleware object and then starts (~1179 tok)

## .wrangler/tmp/bundle-LYKftZ/

- `middleware-insertion-facade.js` — Exports __INTERNAL_WRANGLER_MIDDLEWARE__ (~199 tok)
- `middleware-loader.entry.ts` — This loads all middlewares exposed on the middleware object and then starts (~1179 tok)

## .wrangler/tmp/bundle-c3vJYB/

- `middleware-insertion-facade.js` — Exports __INTERNAL_WRANGLER_MIDDLEWARE__ (~199 tok)
- `middleware-loader.entry.ts` — This loads all middlewares exposed on the middleware object and then starts (~1179 tok)

## .wrangler/tmp/bundle-evyOqN/

- `middleware-insertion-facade.js` — Exports __INTERNAL_WRANGLER_MIDDLEWARE__ (~199 tok)
- `middleware-loader.entry.ts` — This loads all middlewares exposed on the middleware object and then starts (~1179 tok)

## .wrangler/tmp/dev-ZaAjRb/

- `worker.js` — API routes: GET (2 endpoints) (~9018 tok)
- `worker.js.map` — ID_RE: getTeam, putTeam, flow + 8 more (~17792 tok)

## .wrangler/tmp/dev-eN5I4k/

- `worker.js` — API routes: GET (2 endpoints) (~9018 tok)
- `worker.js.map` — ID_RE: getTeam, putTeam, flow + 8 more (~17792 tok)

## .wrangler/tmp/dev-koSKow/

- `worker.js` — API routes: GET (2 endpoints) (~9018 tok)
- `worker.js.map` — ID_RE: getTeam, putTeam, flow + 8 more (~17792 tok)

## .wrangler/tmp/dev-n1hBDV/

- `worker.js` — API routes: GET (2 endpoints) (~9018 tok)
- `worker.js.map` — ID_RE: getTeam, putTeam, flow + 8 more (~17792 tok)

## .wrangler/tmp/dev-pKt3BY/

- `worker.js` — API routes: GET (2 endpoints) (~9018 tok)
- `worker.js.map` — ID_RE: getTeam, putTeam, flow + 8 more (~17792 tok)

## docs/

- `azure-research.md` — Azure as a future home — research (~1602 tok)
- `coaching-guide-audit.md` — Coach's Sideline — audit against the U8 coaching guide (~3807 tok)
- `Fall 2026 - Guide for Coaching U8.md` — **Guide for Coaching U8 at AYSO Region 630** (~1461 tok)
- `firebase-research.md` — Firebase as a future home — research (~1937 tok)
- `game-day-design-prompt.md` — Game Day UI — design iteration prompt (~1488 tok)
- `game-day-ui-plan.md` — Game Day UI — plan and adversarial review (~10821 tok)
- `gamechanger-integration-plan.md` — GameChanger & League Platform Integration — Findings and Plan (~3109 tok)
- `on-field-design-prompt.md` — "On the field" — design iteration prompt (~2270 tok)
- `voice-game-log-plan.md` — "Call the game out loud" — voice event log + LLM reporting (~13143 tok)

## docs/handoffs/design_handoff_game_day_8b/

- `Game Day Harness.dc.html` (~75120 tok)
- `HANDOFF.md` — Handoff: Game Day "On the field" panel — option 8b (~3497 tok)
- `support.js` — getReact: getReactDOM, parseDcDocument, parseDcText + 10 more (~19753 tok)

## docs/handoffs/github-repo-coach-app-connection/

- `README.md` — Project documentation (~422 tok)

## docs/handoffs/github-repo-coach-app-connection/project/

- `.thumbnail` (~3484 tok)
- `Coaching Guide Audit.dc.html` (~7367 tok)
- `doc-page.js` — <doc-page> — paged-document shell for printable HTML. (~10594 tok)
- `Game Day Harness.dc.html` (~42268 tok)
- `github.md` — Last sync (~287 tok)
- `support.js` — getReact: getReactDOM, parseDcDocument, parseDcText + 10 more (~19753 tok)

## docs/handoffs/github-repo-coach-app-connection/project/uploads/

- `game-day-ui-plan.md` — Game Day UI — plan and adversarial review (~10821 tok)

## migrations/

- `0001_games_venue.sql` — Adds games.venue ("home" | "away"). (~239 tok)
- `0002_teams_pass.sql` — Adds teams.pass_hash (optional per-team login passphrase). (~195 tok)

## public/

- `_headers` — Security headers for the static app. Workers static assets support _headers (~256 tok)
- `app.css` — Styles: 61 vars (~17677 tok)
- `app.js` — nowMs: fmt, load, loadMeta + 24 more (~43512 tok)
- `diagram.js` — SVG drill diagrams: spec -> markup string. Pure — no DOM, no app state. (~909 tok)
- `drills.js` — Drill library — static content, no logic. Loaded before app.js; exposes DRILLS. (~2681 tok)
- `index.html` — Coach's Sideline — U8 AYSO (~6315 tok)
- `lineup-core.js` — posSplit: tally, appOf, activeEntry + 17 more (~5599 tok)
- `manifest.webmanifest` (~101 tok)
- `outbox.js` — load: save, flush (~916 tok)
- `state.js` — defaults: fixup, migrate, load (~955 tok)
- `stats.js` — detailOf: rollupEvents, withTimeFixes (~687 tok)
- `sw.js` — Shell cache so a cold launch works with no signal (the sideline case). (~820 tok)

## src/

- `worker.js` — Coach's Sideline — Cloudflare Worker (~9688 tok)

## test/

- `archive.test.mjs` — In-memory stand-in for the archive tables. Statements are matched on the (~2636 tok)
- `auth.test.mjs` — API routes: GET (5 endpoints) (~2647 tok)
- `credit.test.mjs` — lineup-core.js is a plain browser script; evaluate it and grab the global. (~3082 tok)
- `iv.test.mjs` — lineup-core.js is a plain browser script; evaluate it and grab the global. (~2031 tok)
- `lineup.test.mjs` — lineup-core.js is a plain browser script; evaluate it and grab the global. (~4340 tok)
- `outbox.test.mjs` — outbox.js is a plain browser script. It reads localStorage and fetch as free (~1504 tok)
- `played.test.mjs` — lineup-core.js is a plain browser script; evaluate it and grab the global. (~2000 tok)
- `schedule.test.mjs` — API routes: GET (1 endpoints) (~1717 tok)
- `season.test.mjs` — src: rng, buildGame, commit + 5 more (~5899 tok)
- `state.test.mjs` — state.js is a plain browser script: it reads LineupCore and localStorage as (~1689 tok)
- `stats.test.mjs` — Declares src (~1593 tok)
- `worker.test.mjs` — Minimal in-memory stand-in for the D1 binding: enough of prepare/bind/first/run (~1751 tok)
