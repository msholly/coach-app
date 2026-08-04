# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-08-04T03:40:19.543Z
> Files: 42 tracked | Anatomy hits: 0 | Misses: 0

## ../AppData/Local/Temp/claude/c--Users-msholly-coach-app/71c413cb-bc0b-4729-abe9-c29f0a98bcfc/scratchpad/

- `verify-drill-link.mjs` — Declares require (~595 tok)

## ./

- `.gitignore` — Git ignore rules (~14 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `docker-compose.yml` — Docker Compose services (~145 tok)
- `Fall 2026 - Guide for Coaching U8.md` — **Guide for Coaching U8 at AYSO Region 630** (~1461 tok)
- `package-lock.json` — npm lock file (~14099 tok)
- `package.json` — Node.js package manifest (~162 tok)
- `README.md` — Project documentation (~917 tok)
- `schema.sql` — Database schema (~838 tok)
- `wrangler.jsonc` (~305 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .wrangler/state/v3/cache/miniflare-CacheObject/

- `metadata.sqlite-shm` (~8738 tok)
- `metadata.sqlite-wal` (~2206 tok)

## .wrangler/state/v3/d1/miniflare-D1DatabaseObject/

- `metadata.sqlite-shm` (~8739 tok)
- `metadata.sqlite-wal` (~2206 tok)

## .wrangler/state/v3/observability/miniflare-wobs-trace-store/

- `a590acd76969f996ec6e4b599c3c09f58c283a76f2d61392b5d3046caf557602.sqlite-shm` (~8739 tok)
- `metadata.sqlite-shm` (~8738 tok)
- `metadata.sqlite-wal` (~2206 tok)

## .wrangler/tmp/bundle-5Y20eU/

- `middleware-insertion-facade.js` — Exports __INTERNAL_WRANGLER_MIDDLEWARE__ (~199 tok)
- `middleware-loader.entry.ts` — This loads all middlewares exposed on the middleware object and then starts (~1179 tok)

## .wrangler/tmp/bundle-vw30xJ/

- `middleware-insertion-facade.js` — Exports __INTERNAL_WRANGLER_MIDDLEWARE__ (~199 tok)
- `middleware-loader.entry.ts` — This loads all middlewares exposed on the middleware object and then starts (~1179 tok)

## .wrangler/tmp/dev-IGlImC/

- `worker.js` — API routes: GET (4 endpoints) (~4476 tok)
- `worker.js.map` — ID_RE: getTeam, putTeam, postGame + 5 more (~8482 tok)

## .wrangler/tmp/dev-XSW8J9/

- `worker.js` — API routes: GET (4 endpoints) (~4476 tok)
- `worker.js.map` — ID_RE: getTeam, putTeam, postGame + 5 more (~8482 tok)

## docs/

- `coaching-guide-audit.md` — Coach's Sideline — audit against the U8 coaching guide (~3807 tok)
- `game-day-ui-plan.md` — Game Day UI — plan and adversarial review (~10821 tok)
- `voice-game-log-plan.md` — "Call the game out loud" — voice event log + LLM reporting (~13143 tok)

## public/

- `app.css` — Styles: 57 vars (~6693 tok)
- `app.js` — nowMs: fmt, load, fixup + 18 more (~15549 tok)
- `diagram.js` — SVG drill diagrams: spec -> markup string. Pure — no DOM, no app state. (~909 tok)
- `drills.js` — Drill library — static content, no logic. Loaded before app.js; exposes DRILLS. (~2681 tok)
- `index.html` — Coach's Sideline — U8 AYSO (~4800 tok)
- `lineup-core.js` — posSplit: tally, appOf, activeEntry + 10 more (~2419 tok)
- `manifest.webmanifest` (~101 tok)
- `sw.js` — Shell cache so a cold launch works with no signal (the sideline case). (~479 tok)

## src/

- `worker.js` — Coach's Sideline — Cloudflare Worker (~3270 tok)

## test/

- `archive.test.mjs` — In-memory stand-in for the archive tables. Statements are matched on the (~2345 tok)
- `lineup.test.mjs` — lineup-core.js is a plain browser script; evaluate it and grab the global. (~2667 tok)
- `worker.test.mjs` — Minimal in-memory stand-in for the D1 binding: enough of prepare/bind/first/run (~1175 tok)
