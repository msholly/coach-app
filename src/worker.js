// Coach's Sideline — Cloudflare Worker
// Serves the static app (via the ASSETS binding) and a tiny JSON API backed by D1.
// The whole app state for a team is stored as ONE JSON document (last-write-wins,
// with an optimistic-concurrency check so a stale write is flagged, not silently lost).

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;   // team ids are unguessable tokens
const MAX_DOC_BYTES = 512 * 1024;        // 512 KB cap on a team document
const GID_RE = /^[A-Za-z0-9_-]{4,80}$/;  // client-generated game/event ids
const BATCH_MAX = 500;                   // one bad client must not insert unbounded rows
const POS = new Set(["GK", "D", "F"]);

// Strip anything that looks like a credential out of text bound for a response
// or a log line. The GameChanger calendar URL carries a bearer token in its
// query string, and a thrown fetch error quotes the URL it was given.
const SECRETISH = /([?&](?:token|key|auth|access_token|sig)=)[^&\s"']+/gi;
const redact = (s) => String(s == null ? "" : s).replace(SECRETISH, "$1[redacted]");

// The D1 binding is either the auto-generated "coach_sideline_db" name or the
// template default "DB". One place to resolve it.
const dbOf = (env) => env.coach_sideline_db || env.DB;

// One parse point for every JSON request body: null means "unparseable", which
// every caller turns into a 400. A valid `null` JSON body is unparseable too,
// which is the right answer everywhere here.
async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // Static assets get their headers from public/_headers; API responses are
      // minted here, so the sniffing guard has to be set here too.
      "x-content-type-options": "nosniff",
      ...extra,
    },
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

        const db = dbOf(env);
        const denied = await gate(db, id, request);
        if (denied) return denied;
        if (request.method === "GET") return getTeam(db, id);
        if (request.method === "PUT") return putTeam(db, id, request, url);
        return json({ error: "method_not_allowed" }, 405, { allow: "GET, PUT" });
      }

      // /api/team/:id/(games|events|appearances|positions)[/:gid] — the
      // append-only archive beside the live doc. Same ID_RE trust boundary.
      const m2 = path.match(/^\/api\/team\/([^/]+)\/(games|events|appearances|positions|stats|push|alarm|schedule|auth)(?:\/([^/]+))?$/);
      if (m2) {
        const id = decodeURIComponent(m2[1]);
        if (!ID_RE.test(id)) return json({ error: "bad_team_id" }, 400);
        const db = dbOf(env);
        const kind = m2[2], sub = m2[3] ? decodeURIComponent(m2[3]) : null;

        // /auth is the way IN, so it cannot sit behind the gate.
        if (kind === "auth" && !sub) {
          if (request.method === "GET") return authStatus(db, id, request);
          if (request.method === "POST") return postAuth(env, db, id, request);
          return json({ error: "method_not_allowed" }, 405, { allow: "GET, POST" });
        }
        const denied = await gate(db, id, request);
        if (denied) return denied;

        if (kind === "games" && !sub && request.method === "POST") return postGame(db, id, request);
        if (kind === "games" && !sub && request.method === "GET") return listGames(db, id, url);
        if (kind === "games" && sub && request.method === "GET") return getGameEvents(db, id, sub);
        if (kind === "events" && !sub && request.method === "POST") return postEvents(db, id, request);
        if (kind === "appearances" && !sub && request.method === "POST") return postAppearances(db, id, request);
        if (kind === "positions" && !sub && request.method === "GET") return getPositions(db, id, url);
        if (kind === "stats" && !sub && request.method === "GET") return getStats(db, id, url);
        if (kind === "push" && !sub && request.method === "POST") return postPushSub(db, id, request);
        if (kind === "push" && !sub && request.method === "DELETE") return deletePushSub(db, id, request);
        if (kind === "alarm" && !sub && request.method === "POST") return postAlarm(env, id, request);
        if (kind === "schedule" && !sub && request.method === "GET") return getSchedule(env, db, id);
        return json({ error: "method_not_allowed" }, 405);
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      // redact(): a failed subrequest puts the URL it tried into the message, and
      // the calendar URL carries a bearer token. Never let one reach a response.
      return json({ error: "server_error", detail: redact(String(err && err.message || err)) }, 500);
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
  const body = await readJson(request);
  if (body === null) return json({ error: "invalid_json_body" }, 400);
  const doc = body.doc;
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

  // Conditional write, not the old SELECT-then-blind-upsert: two writers who both
  // read curRev=5 would both have passed the baseRev check above and both written
  // rev=6, silently losing one edit. Guard the UPDATE on the rev we just read so
  // the second writer's UPDATE matches no row (changes===0) and gets a 409.
  // force / baseRev:null keep writing unconditionally (UPDATE-by-id, INSERT if new).
  const guarded = !force && baseRev !== null;
  const res = guarded
    ? await db.prepare("UPDATE teams SET doc = ?, rev = ?, updated_at = ? WHERE id = ? AND rev = ?")
        .bind(doc, newRev, now, id, curRev).run()
    : await db.prepare("UPDATE teams SET doc = ?, rev = ?, updated_at = ? WHERE id = ?")
        .bind(doc, newRev, now, id).run();

  if ((res.meta ? res.meta.changes : 0) === 0) {
    if (!cur) {
      // First write for this id — no row to update.
      await db.prepare("INSERT INTO teams (id, doc, rev, updated_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, doc, newRev, now, now).run();
      return json({ id, rev: newRev, updatedAt: now });
    }
    // A row exists but the guarded UPDATE matched nothing: someone advanced the
    // rev between our SELECT and our UPDATE. Return the current doc to reconcile.
    const full = await db.prepare("SELECT doc, rev, updated_at FROM teams WHERE id = ?").bind(id).first();
    return json(
      { error: "conflict", id, doc: full ? full.doc : null, rev: full ? full.rev : curRev, updatedAt: full ? full.updated_at : null },
      409
    );
  }

  return json({ id, rev: newRev, updatedAt: now });
}

/* ========================= login (team passphrase) =========================
   The token in the share link is a capability: whoever holds the link holds the
   team. That is right for a link texted to two assistant coaches and wrong the
   moment it leaks, so a team can add a passphrase and become two things — the
   link AND the phrase.

   Shaped for what this app actually is: ONE shared passphrase per team, no
   accounts, no email, no reset flow (there is no address to send one to). A
   passphrase is opt-in; a team without one behaves exactly as it did before.
   A coach who forgets theirs still has every byte of the team in localStorage
   on their own phone, and recovery is a one-line D1 UPDATE (see migrations/0002).

   ponytail: the session cookie is signed with the team's own pass_hash, so
   there is no session secret to generate, store or rotate — and changing the
   passphrase invalidates every outstanding session on every device for free.
   b64uEncode/b64uDecode are the VAPID helpers further down this file. */

const SESSION_MS = 30 * 24 * 3600 * 1000;   // a coach re-enters it about once a month
const MIN_PASS = 6, MAX_PASS = 200;
// Workers Free allows 10 ms of CPU per request, and PBKDF2-SHA256 measures
// ~0.5 ms per 1000 iterations — so the usual 100k advice would blow the whole
// budget on every login. The count is stored INSIDE the hash, so raising it on
// a paid plan costs nothing: existing hashes keep verifying at their own count.
const PBKDF2_ITERS = 10000;
const te = new TextEncoder();

const sessionName = (id) => "cs_" + id;   // per-team: one device can hold several
const cookieAttrs = "Path=/api; HttpOnly; Secure; SameSite=Strict";

function cookieVal(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Compare in constant time: a byte-at-a-time early exit leaks the expected
// value one guess per byte.
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function pbkdf2(pass, salt, iters) {
  const key = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iters }, key, 256);
  return new Uint8Array(bits);
}

async function hashPass(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERS}$${b64uEncode(salt)}$${b64uEncode(await pbkdf2(pass, salt, PBKDF2_ITERS))}`;
}

async function verifyPass(pass, stored) {
  const p = String(stored || "").split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2") return false;
  const iters = +p[1];
  if (!Number.isInteger(iters) || iters < 1000 || iters > 600000) return false;
  return sameBytes(await pbkdf2(pass, b64uDecode(p[2]), iters), b64uDecode(p[3]));
}

async function signSession(passHash, id, exp) {
  const key = await crypto.subtle.importKey("raw", te.encode(passHash), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return exp + "." + b64uEncode(await crypto.subtle.sign("HMAC", key, te.encode(id + "." + exp)));
}

async function sessionCookie(passHash, id) {
  const exp = Date.now() + SESSION_MS;
  return `${sessionName(id)}=${await signSession(passHash, id, exp)}; Max-Age=${Math.floor(SESSION_MS / 1000)}; ${cookieAttrs}`;
}
const clearCookie = (id) => `${sessionName(id)}=; Max-Age=0; ${cookieAttrs}`;

async function validSession(passHash, id, val) {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{20,})$/.exec(String(val || ""));
  if (!m || +m[1] <= Date.now()) return false;
  return sameBytes(te.encode(await signSession(passHash, id, +m[1])), te.encode(val));
}

// Every /api/team/:id* route runs through this. Returns a Response to send
// instead of the handler, or null to carry on. One extra PK lookup per API
// call — the price of the doc and the lock living in the same row.
async function gate(db, id, request) {
  const row = await db.prepare("SELECT pass_hash FROM teams WHERE id = ?").bind(id).first();
  // No row yet (a team's first write) or no passphrase set: the link is the gate,
  // exactly as before. Locking is opt-in — nobody's existing link stops working.
  if (!row || !row.pass_hash) return null;
  if (await validSession(row.pass_hash, id, cookieVal(request, sessionName(id)))) return null;
  return json({ error: "locked" }, 401);
}

// GET /api/team/:id/auth — what the client needs before it decides to prompt.
async function authStatus(db, id, request) {
  const row = await db.prepare("SELECT pass_hash FROM teams WHERE id = ?").bind(id).first();
  const hash = row && row.pass_hash;
  if (!hash) return json({ exists: !!row, locked: false, authed: true });
  return json({ exists: true, locked: true, authed: await validSession(hash, id, cookieVal(request, sessionName(id))) });
}

// POST /api/team/:id/auth
//   { pass }               log in
//   { newPass }            set or change the passphrase (see below for who may)
//   { pass, newPass }      change it from a device with no live session
//   { newPass: null }      remove it, unlocking the team
async function postAuth(env, db, id, request) {
  const b = await readJson(request);
  if (b === null) return json({ error: "invalid_json_body" }, 400);

  // Rate limit BEFORE any PBKDF2 work: unlimited guesses are both the
  // brute-force path and a way to burn the Worker's CPU budget. Keyed on the
  // team rather than the caller's IP because a distributed guesser just rotates
  // IPs; the cost of the stricter key is that a team under attack can't log in
  // for a minute, and the app stays fully usable offline meanwhile.
  if (env.LOGIN_LIMIT) {
    const { success } = await env.LOGIN_LIMIT.limit({ key: id });
    if (!success) return json({ error: "too_many_attempts" }, 429, { "retry-after": "60" });
  }

  const row = await db.prepare("SELECT pass_hash FROM teams WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "not_found" }, 404);
  const cur = row.pass_hash || null;
  // Phones autocapitalise and autocomplete into this field; a trailing space
  // that locks a coach out of their own team is not a security win.
  const pass = typeof b.pass === "string" ? b.pass.trim() : "";

  // Session first — it is an HMAC, where verifyPass is the expensive KDF, so a
  // logged-in device changing its passphrase pays for one derivation, not two.
  // On an unlocked team, holding the link IS the credential: that is what lets
  // the first passphrase be set at all.
  const authed = !cur || (await validSession(cur, id, cookieVal(request, sessionName(id)))) || (!!pass && await verifyPass(pass, cur));
  if (!authed) return json({ error: "bad_passphrase" }, 401);

  if ("newPass" in b) {
    if (b.newPass === null) {
      await db.prepare("UPDATE teams SET pass_hash = NULL WHERE id = ?").bind(id).run();
      return json({ locked: false, authed: true }, 200, { "set-cookie": clearCookie(id) });
    }
    const np = typeof b.newPass === "string" ? b.newPass.trim() : "";
    if (np.length < MIN_PASS || np.length > MAX_PASS) return json({ error: "bad_passphrase_length", min: MIN_PASS, max: MAX_PASS }, 400);
    const hash = await hashPass(np);
    await db.prepare("UPDATE teams SET pass_hash = ? WHERE id = ?").bind(hash, id).run();
    return json({ locked: true, authed: true }, 200, { "set-cookie": await sessionCookie(hash, id) });
  }

  if (!cur) return json({ locked: false, authed: true });
  return json({ locked: true, authed: true }, 200, { "set-cookie": await sessionCookie(cur, id) });
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
  const b = await readJson(request);
  if (b === null) return json({ error: "invalid_json_body" }, 400);
  if (!GID_RE.test(String(b.id || ""))) return json({ error: "bad_game_id" }, 400);
  const started = +b.started_at;
  if (!Number.isFinite(started) || started <= 0) return json({ error: "bad_started_at" }, 400);
  const ended = +b.ended_at;
  // Anything not in this set is stored as NULL — "not recorded" must stay
  // distinguishable from "home", or every pre-migration row reads as a home game.
  const venue = b.venue === "home" || b.venue === "away" ? b.venue : null;
  await db.prepare(
    "INSERT INTO games (id, team_id, season, format, started_at, ended_at, opponent, venue, us, them, periods, onfield, minsper) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET season = excluded.season, ended_at = excluded.ended_at, " +
    "opponent = excluded.opponent, venue = excluded.venue, us = excluded.us, them = excluded.them " +
    "WHERE games.team_id = excluded.team_id"
  ).bind(
    String(b.id), teamId, str(b.season, 64), str(b.format, 16), started,
    Number.isFinite(ended) && ended > 0 ? ended : null,
    b.opponent ? str(b.opponent, 80) : null,
    venue,
    +b.us || 0, +b.them || 0, +b.periods || 0, +b.onfield || 0, +b.minsper || 0
  ).run();
  return json({ ok: true, id: String(b.id) });
}

async function postEvents(db, teamId, request) {
  const b = await readJson(request);
  if (b === null) return json({ error: "invalid_json_body" }, 400);
  const list = Array.isArray(b.events) ? b.events : null;
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
  const b = await readJson(request);
  if (b === null) return json({ error: "invalid_json_body" }, 400);
  const rows = Array.isArray(b.rows) ? b.rows : null;
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

// Season goal/shot totals per player, netted against their own corrections —
// the archive is append-only, so an undo is a second row, not a deletion:
//   goal  → detail.d is +1 or -1, so summing it IS the net
//   sog   → detail.correction marks the undo, which counts as -1
// Team goals with no scorer (the plain +/- buttons) carry player_id NULL and
// are excluded here; the games table already holds the team score.
async function getStats(db, teamId, url) {
  const season = url.searchParams.get("season") || "";
// Assists ride in the scoring row's detail.assistId, so they are a second pass
// over the same rows keyed on a different player — hence the UNION ALL.
  const rs = await db.prepare(
    "SELECT player_id, SUM(goals) AS goals, SUM(assists) AS assists, SUM(shots) AS shots FROM (" +
    "SELECT player_id, " +
    "SUM(CASE WHEN kind = 'goal' THEN COALESCE(json_extract(detail, '$.d'), 1) ELSE 0 END) AS goals, " +
    "0 AS assists, " +
    "SUM(CASE WHEN kind = 'sog' THEN (CASE WHEN json_extract(detail, '$.correction') IS NULL THEN 1 ELSE -1 END) ELSE 0 END) AS shots " +
    "FROM game_events " +
    "WHERE player_id IS NOT NULL AND kind IN ('goal', 'sog') " +
    "AND game_id IN (SELECT id FROM games WHERE team_id = ? AND season = ?) " +
    "GROUP BY player_id " +
    "UNION ALL " +
    "SELECT json_extract(detail, '$.assistId') AS player_id, 0 AS goals, " +
    "SUM(COALESCE(json_extract(detail, '$.d'), 1)) AS assists, 0 AS shots " +
    "FROM game_events " +
    "WHERE kind = 'goal' AND json_extract(detail, '$.assistId') IS NOT NULL " +
    "AND game_id IN (SELECT id FROM games WHERE team_id = ? AND season = ?) " +
    "GROUP BY json_extract(detail, '$.assistId')" +
    ") GROUP BY player_id"
  ).bind(teamId, season, teamId, season).all();
  return json({ stats: rs.results || [] });
}

// Requirement 3 collapses to this one query, scoped to team AND season.
// ?exclude= keeps the in-progress game out — the client holds its periods
// locally and would otherwise double-count them.
// ?byGame=1 additionally returns the same sums split by game — the player card's
// "game over game" list. Same one query shape, one extra GROUP BY column.
async function getPositions(db, teamId, url) {
  const season = url.searchParams.get("season") || "";
  const exclude = url.searchParams.get("exclude") || "";
  const rs = await db.prepare(
    "SELECT player_id, pos, ROUND(SUM(frac), 1) AS periods FROM appearances " +
    "WHERE game_id IN (SELECT id FROM games WHERE team_id = ? AND season = ?) AND game_id <> ? " +
    "GROUP BY player_id, pos"
  ).bind(teamId, season, exclude).all();
  const out = { positions: rs.results || [] };
  if (url.searchParams.get("byGame")) {
    const bg = await db.prepare(
      "SELECT game_id, player_id, pos, ROUND(SUM(frac), 1) AS periods FROM appearances " +
      "WHERE game_id IN (SELECT id FROM games WHERE team_id = ? AND season = ?) AND game_id <> ? " +
      "GROUP BY game_id, player_id, pos"
    ).bind(teamId, season, exclude).all();
    out.byGame = bg.results || [];
  }
  return json(out);
}

/* ==================== GameChanger schedule (read-only) ====================
   GameChanger publishes a per-team ICS subscription feed. It is read-only —
   there is still no write path into GC — and its URL carries a bearer token in
   the query string, which is why this is a server-side proxy and not a fetch
   from the browser:

     - the token lives in the GC_ICS_URL secret, never in the client bundle,
       never in the repo, never in a URL the browser sees;
     - the browser cannot reach api.team-manager.gc.com directly anyway (CORS);
     - every error path goes through redact() so a failed subrequest can't
       echo the token back out.

   Set it with:  npx wrangler secret put GC_ICS_URL
   Locally:      GC_ICS_URL=... in .dev.vars (gitignored)                    */

// RFC 5545 folds long lines by starting the continuation with a space or tab.
// Unfold before parsing or a LOCATION longer than 75 octets arrives in pieces.
function unfoldIcs(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

// GameChanger's own convention, and the only place home/away appears:
//   "Fall 2026 BU8 @ Rangers"  -> away
//   "Fall 2026 BU8 vs Rangers" -> home
// Anything else (a practice, a placeholder with no separator) yields null,
// which the app must treat as "not recorded" rather than defaulting to home.
function venueFromSummary(summary) {
  const s = String(summary || "");
  let m = s.match(/\s+vs\.?\s+(.+)$/i);
  if (m) return { venue: "home", opponent: m[1].trim() || null };
  m = s.match(/\s+@\s+(.+)$/);
  if (m) return { venue: "away", opponent: m[1].trim() || null };
  return { venue: null, opponent: null };
}

// ICS UTC stamps: 20260912T170000Z. Returned as ms epoch so the client needs
// no date library; a floating (non-Z) time is left null rather than guessed.
function icsDateMs(v) {
  const m = String(v || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

const unescapeIcs = (v) => String(v || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

export function parseIcsEvents(text) {
  const out = [];
  const body = unfoldIcs(text);
  const blocks = body.split("BEGIN:VEVENT").slice(1);
  for (const raw of blocks) {
    const block = raw.split("END:VEVENT")[0];
    const field = (name) => {
      // properties may carry parameters: DTSTART;TZID=...:20260912T170000
      const m = block.match(new RegExp("^" + name + "(?:;[^:\\n]*)?:(.*)$", "mi"));
      return m ? m[1].trim() : "";
    };
    const summary = unescapeIcs(field("SUMMARY"));
    const { venue, opponent } = venueFromSummary(summary);
    out.push({
      uid: field("UID") || null,
      startsAt: icsDateMs(field("DTSTART")),
      endsAt: icsDateMs(field("DTEND")),
      summary,
      location: unescapeIcs(field("LOCATION")) || null,
      description: unescapeIcs(field("DESCRIPTION")) || null,
      venue,
      opponent,
    });
  }
  return out.sort((a, b) => (a.startsAt || 0) - (b.startsAt || 0));
}

async function getSchedule(env, db, id) {
  // gate() lets a nonexistent team through (link is the credential on an unlocked
  // team), and the GC feed is a single global secret — so without this check
  // ANY well-formed id would be served the coach's family schedule. Require the
  // team row to exist. ponytail: a row-existence check, not an env allowlist —
  // real team ids are 128-bit random and unguessable.
  const team = await db.prepare("SELECT 1 FROM teams WHERE id = ?").bind(id).first();
  if (!team) return json({ error: "not_found" }, 404);

  const raw = env.GC_ICS_URL;
  if (!raw) return json({ error: "schedule_unavailable", reason: "GC_ICS_URL is not set" }, 501);
  // The subscribe link is handed out as webcal://; that scheme means nothing to fetch().
  const target = String(raw).trim().replace(/^webcal:\/\//i, "https://");
  if (!/^https:\/\//i.test(target)) return json({ error: "schedule_misconfigured" }, 500);

  let res;
  try {
    // GC advertises X-PUBLISHED-TTL of 5h; 30 min keeps a same-day change visible
    // without hammering their endpoint on every page load.
    res = await fetch(target, {
      headers: { accept: "text/calendar" },
      cf: { cacheTtl: 1800, cacheEverything: true },
    });
  } catch (err) {
    return json({ error: "schedule_fetch_failed", detail: redact(String(err && err.message || err)) }, 502);
  }
  if (!res.ok) return json({ error: "schedule_fetch_failed", status: res.status }, 502);

  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) return json({ error: "schedule_not_calendar" }, 502);

  const name = (text.match(/^X-WR-CALNAME:(.*)$/mi) || [])[1];
  return json(
    { calendar: name ? unescapeIcs(name.trim()) : null, events: parseIcsEvents(text) },
    200,
    // The response body is the coach's own schedule — never a shared/public cache.
    { "cache-control": "private, max-age=300" }
  );
}

/* ============================ web push ============================
   The period-end alarm has to survive a locked phone, where no JS of ours
   runs. That means the *server* has to fire at the whistle, so the client
   registers the deadline with a Durable Object alarm on every clock start
   and cancels it on every stop.

   ponytail: the push carries NO payload. A payload would have to be
   encrypted (ECDH + HKDF + AES128GCM against the subscription keys); with
   VAPID alone the request is just a signed POST with an empty body, and the
   notification text lives in sw.js. The full PushSubscription is stored
   anyway, so the day the text needs to vary per event the keys are there. */

const MAX_ENDPOINT = 1024;

const b64uEncode = (buf) => {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64uDecode = (str) => {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// RFC 8292: a JWT signed with the app's VAPID key, plus the public key, so the
// push service can tell that whoever subscribed is who is now sending.
export async function vapidAuth(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64uEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,   // spec caps this at 24h
    sub: env.VAPID_SUBJECT || "mailto:coach@example.com",
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  const pub = b64uEncode(new Uint8Array([4, ...b64uDecode(jwk.x), ...b64uDecode(jwk.y)]));
  return { auth: `vapid t=${head}.${body}.${b64uEncode(sig)}, k=${pub}`, pub };
}

// Returns the HTTP status so the caller can prune a subscription the push
// service has retired (404/410) — those never come back.
async function sendPush(env, endpoint) {
  const { auth } = await vapidAuth(env, endpoint);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: auth, TTL: "600", Urgency: "high", "content-length": "0" },
  });
  return res.status;
}

async function postPushSub(db, id, request) {
  const body = await readJson(request);
  if (body === null) return json({ error: "invalid_json_body" }, 400);
  const sub = body.sub;
  const endpoint = sub && sub.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT) return json({ error: "bad_endpoint" }, 400);
  let u;
  try { u = new URL(endpoint); } catch { return json({ error: "bad_endpoint" }, 400); }
  if (u.protocol !== "https:") return json({ error: "bad_endpoint" }, 400);

  await db
    .prepare("INSERT INTO push_subs (endpoint, team_id, sub, created_at) VALUES (?, ?, ?, ?)"
      + " ON CONFLICT(endpoint) DO UPDATE SET team_id = excluded.team_id, sub = excluded.sub")
    .bind(endpoint, id, JSON.stringify(sub), Date.now())
    .run();
  return json({ ok: true });
}

async function deletePushSub(db, id, request) {
  const body = await readJson(request);
  if (body === null) return json({ error: "invalid_json_body" }, 400);
  const endpoint = body.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT) return json({ error: "bad_endpoint" }, 400);
  await db.prepare("DELETE FROM push_subs WHERE endpoint = ? AND team_id = ?").bind(endpoint, id).run();
  return json({ ok: true });
}

// { at: <ms epoch> } arms the alarm, { at: 0 } cancels it. One Durable Object
// per team, so a second device starting the clock just moves the same alarm.
async function postAlarm(env, id, request) {
  if (!env.GAME_CLOCK) return json({ error: "alarms_unavailable" }, 501);
  const body = await readJson(request);
  if (body === null) return json({ error: "invalid_json_body" }, 400);
  const at = Number(body.at) || 0;
  // A far-future alarm would pin a DO forever; a past one would fire instantly.
  if (at && (at < Date.now() || at > Date.now() + 6 * 3600 * 1000)) return json({ error: "bad_alarm_time" }, 400);
  const stub = env.GAME_CLOCK.get(env.GAME_CLOCK.idFromName(id));
  await stub.fetch("https://alarm/set", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ at, team: id }),
  });
  return json({ ok: true, at });
}

export class GameClock {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const { at, team } = await request.json();
    if (at > 0) {
      await this.ctx.storage.put("team", team);
      await this.ctx.storage.setAlarm(at);
    } else {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete("team");
    }
    return new Response(null, { status: 204 });
  }

  async alarm() {
    // The whole body is wrapped: a throw here (e.g. the DELETE prune below) makes
    // the DO runtime RETRY the alarm, which re-notifies every phone. Log-and-swallow.
    try {
      const team = await this.ctx.storage.get("team");
      if (!team) return;
      const db = dbOf(this.env);
      const { results } = await db.prepare("SELECT endpoint FROM push_subs WHERE team_id = ?").bind(team).all();
      for (const row of results || []) {
        let status = 0;
        try { status = await sendPush(this.env, row.endpoint); } catch { /* a dead push service must not block the rest */ }
        if (status === 404 || status === 410) {
          await db.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(row.endpoint).run();
        }
      }
    } catch (err) {
      console.log("GameClock.alarm failed:", redact(String(err && err.message || err)));
    }
  }
}
