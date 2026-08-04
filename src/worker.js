// Coach's Sideline — Cloudflare Worker
// Serves the static app (via the ASSETS binding) and a tiny JSON API backed by D1.
// The whole app state for a team is stored as ONE JSON document (last-write-wins,
// with an optimistic-concurrency check so a stale write is flagged, not silently lost).

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;   // team ids are unguessable tokens
const MAX_DOC_BYTES = 512 * 1024;        // 512 KB cap on a team document
const GID_RE = /^[A-Za-z0-9_-]{4,80}$/;  // client-generated game/event ids
const BATCH_MAX = 500;                   // one bad client must not insert unbounded rows
const POS = new Set(["GK", "D", "F"]);

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Everything non-/api is handled by static assets (run_worker_first scopes us to /api/*),
    // but guard anyway so a misconfig doesn't 500.
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      // GET /api/health  — used by the frontend to detect that a real backend is present.
      if (path === "/api/health") {
        return json({ ok: true, app: "coach-sideline" });
      }

      // /api/team/:id
      const m = path.match(/^\/api\/team\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!ID_RE.test(id)) return json({ error: "bad_team_id" }, 400);

        // Resolve the D1 binding from wrangler.jsonc — supports the auto-generated
        // "coach_sideline_db" name as well as the template default "DB".
        const db = env.coach_sideline_db || env.DB;
        if (request.method === "GET") return getTeam(db, id);
        if (request.method === "PUT") return putTeam(db, id, request, url);
        return json({ error: "method_not_allowed" }, 405, { allow: "GET, PUT" });
      }

      // /api/team/:id/(games|events|appearances|positions)[/:gid] — the
      // append-only archive beside the live doc. Same ID_RE trust boundary.
      const m2 = path.match(/^\/api\/team\/([^/]+)\/(games|events|appearances|positions)(?:\/([^/]+))?$/);
      if (m2) {
        const id = decodeURIComponent(m2[1]);
        if (!ID_RE.test(id)) return json({ error: "bad_team_id" }, 400);
        const db = env.coach_sideline_db || env.DB;
        const kind = m2[2], sub = m2[3] ? decodeURIComponent(m2[3]) : null;
        if (kind === "games" && !sub && request.method === "POST") return postGame(db, id, request);
        if (kind === "games" && !sub && request.method === "GET") return listGames(db, id, url);
        if (kind === "games" && sub && request.method === "GET") return getGameEvents(db, id, sub);
        if (kind === "events" && !sub && request.method === "POST") return postEvents(db, id, request);
        if (kind === "appearances" && !sub && request.method === "POST") return postAppearances(db, id, request);
        if (kind === "positions" && !sub && request.method === "GET") return getPositions(db, id, url);
        return json({ error: "method_not_allowed" }, 405);
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      return json({ error: "server_error", detail: String(err && err.message || err) }, 500);
    }
  },
};

async function getTeam(db, id) {
  const row = await db
    .prepare("SELECT doc, rev, updated_at FROM teams WHERE id = ?")
    .bind(id)
    .first();
  if (!row) return json({ error: "not_found" }, 404);
  return json({ id, doc: row.doc, rev: row.rev, updatedAt: row.updated_at });
}

async function putTeam(db, id, request, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }
  const doc = body && body.doc;
  if (typeof doc !== "string") return json({ error: "doc_must_be_string" }, 400);
  if (doc.length > MAX_DOC_BYTES) return json({ error: "doc_too_large", maxBytes: MAX_DOC_BYTES }, 413);
  // The doc must itself be valid JSON (the app state) — reject junk at the boundary.
  try { JSON.parse(doc); } catch { return json({ error: "doc_not_valid_json" }, 400); }

  const force = url.searchParams.get("force") === "1";
  const baseRev = Number.isInteger(body.baseRev) ? body.baseRev : null;

  const cur = await db
    .prepare("SELECT rev FROM teams WHERE id = ?")
    .bind(id)
    .first();
  const curRev = cur ? cur.rev : 0;

  // Optimistic concurrency: if the caller told us what revision it based its edit on,
  // and the server has moved past that, this is a conflict — return the current doc so
  // the client can reconcile (unless ?force=1).
  if (!force && baseRev !== null && baseRev !== curRev) {
    const full = await db
      .prepare("SELECT doc, rev, updated_at FROM teams WHERE id = ?")
      .bind(id)
      .first();
    return json(
      { error: "conflict", id, doc: full ? full.doc : null, rev: curRev, updatedAt: full ? full.updated_at : null },
      409
    );
  }

  const now = Date.now();
  const newRev = curRev + 1;
  await db
    .prepare(
      "INSERT INTO teams (id, doc, rev, updated_at, created_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, rev = excluded.rev, updated_at = excluded.updated_at"
    )
    .bind(id, doc, newRev, now, now)
    .run();

  return json({ id, rev: newRev, updatedAt: now });
}

/* ---------- append-only archive (games / events / appearances) ----------
   Client-generated ids make every write idempotent: INSERT OR IGNORE for
   events, keyed upserts for games and appearances. team_id always comes from
   the (validated) path, never the body, and child rows only land when their
   game row belongs to that team — a token for one team can't write into
   another team's archive. */

const str = (v, n) => String(v == null ? "" : v).slice(0, n);

// Upsert the game row: kickoff writes it, full time (and score changes) update it.
async function postGame(db, teamId, request) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid_json_body" }, 400); }
  if (!b || !GID_RE.test(String(b.id || ""))) return json({ error: "bad_game_id" }, 400);
  const started = +b.started_at;
  if (!Number.isFinite(started) || started <= 0) return json({ error: "bad_started_at" }, 400);
  const ended = +b.ended_at;
  await db.prepare(
    "INSERT INTO games (id, team_id, season, format, started_at, ended_at, opponent, us, them, periods, onfield, minsper) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET season = excluded.season, ended_at = excluded.ended_at, " +
    "opponent = excluded.opponent, us = excluded.us, them = excluded.them " +
    "WHERE games.team_id = excluded.team_id"
  ).bind(
    String(b.id), teamId, str(b.season, 64), str(b.format, 16), started,
    Number.isFinite(ended) && ended > 0 ? ended : null,
    b.opponent ? str(b.opponent, 80) : null,
    +b.us || 0, +b.them || 0, +b.periods || 0, +b.onfield || 0, +b.minsper || 0
  ).run();
  return json({ ok: true, id: String(b.id) });
}

async function postEvents(db, teamId, request) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid_json_body" }, 400); }
  const list = b && Array.isArray(b.events) ? b.events : null;
  if (!list) return json({ error: "events_must_be_array" }, 400);
  if (list.length > BATCH_MAX) return json({ error: "batch_too_large", max: BATCH_MAX }, 400);
  const stmts = [];
  for (const ev of list) {
    if (!ev || !GID_RE.test(String(ev.id || "")) || !GID_RE.test(String(ev.game_id || ""))) return json({ error: "bad_event" }, 400);
    const kind = str(ev.kind, 16);
    if (!kind) return json({ error: "bad_event" }, 400);
    stmts.push(db.prepare(
      "INSERT OR IGNORE INTO game_events (id, game_id, at, period, secs, kind, player_id, detail) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM games WHERE id = ? AND team_id = ?)"
    ).bind(
      String(ev.id), String(ev.game_id), +ev.at || 0, +ev.period || 0, +ev.secs || 0, kind,
      ev.player_id ? str(ev.player_id, 64) : null, ev.detail ? str(ev.detail, 2000) : null,
      String(ev.game_id), teamId
    ));
  }
  if (stmts.length) await db.batch(stmts);
  return json({ ok: true, count: stmts.length });
}

async function postAppearances(db, teamId, request) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid_json_body" }, 400); }
  const rows = b && Array.isArray(b.rows) ? b.rows : null;
  if (!rows) return json({ error: "rows_must_be_array" }, 400);
  if (rows.length > BATCH_MAX) return json({ error: "batch_too_large", max: BATCH_MAX }, 400);
  const stmts = [];
  for (const r of rows) {
    if (!r || !GID_RE.test(String(r.game_id || "")) || !r.player_id) return json({ error: "bad_row" }, 400);
    if (!POS.has(r.pos)) return json({ error: "bad_pos" }, 400);
    const period = +r.period, frac = +r.frac;
    if (!Number.isInteger(period) || period < 1 || period > 12) return json({ error: "bad_period" }, 400);
    if (!Number.isFinite(frac) || frac < 0 || frac > 2) return json({ error: "bad_frac" }, 400);
    stmts.push(db.prepare(
      "INSERT INTO appearances (game_id, player_id, period, pos, frac) " +
      "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM games WHERE id = ? AND team_id = ?) " +
      "ON CONFLICT(game_id, player_id, period, pos) DO UPDATE SET frac = excluded.frac"
    ).bind(String(r.game_id), str(r.player_id, 64), period, r.pos, frac, String(r.game_id), teamId));
  }
  if (stmts.length) await db.batch(stmts);
  return json({ ok: true, count: stmts.length });
}

// Season list — the read view requirement 2 needs.
async function listGames(db, teamId, url) {
  const season = url.searchParams.get("season") || "";
  const q = season
    ? db.prepare("SELECT * FROM games WHERE team_id = ? AND season = ? ORDER BY started_at DESC LIMIT 100").bind(teamId, season)
    : db.prepare("SELECT * FROM games WHERE team_id = ? ORDER BY started_at DESC LIMIT 100").bind(teamId);
  const rs = await q.all();
  return json({ games: rs.results || [] });
}

// One game's events, in order. The JOIN is the ownership check.
async function getGameEvents(db, teamId, gid) {
  if (!GID_RE.test(gid)) return json({ error: "bad_game_id" }, 400);
  const rs = await db.prepare(
    "SELECT e.id, e.game_id, e.at, e.period, e.secs, e.kind, e.player_id, e.detail " +
    "FROM game_events e JOIN games g ON g.id = e.game_id " +
    "WHERE e.game_id = ? AND g.team_id = ? ORDER BY e.at LIMIT 2000"
  ).bind(gid, teamId).all();
  return json({ events: rs.results || [] });
}

// Requirement 3 collapses to this one query, scoped to team AND season.
// ?exclude= keeps the in-progress game out — the client holds its periods
// locally and would otherwise double-count them.
async function getPositions(db, teamId, url) {
  const season = url.searchParams.get("season") || "";
  const exclude = url.searchParams.get("exclude") || "";
  const rs = await db.prepare(
    "SELECT player_id, pos, ROUND(SUM(frac), 1) AS periods FROM appearances " +
    "WHERE game_id IN (SELECT id FROM games WHERE team_id = ? AND season = ?) AND game_id <> ? " +
    "GROUP BY player_id, pos"
  ).bind(teamId, season, exclude).all();
  return json({ positions: rs.results || [] });
}
