import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

// In-memory stand-in for the archive tables. Statements are matched on the
// worker's real SQL text, including the EXISTS ownership sub-select and the
// keyed upserts, so the ownership and idempotency behaviour is exercised.
function makeDb() {
  const games = new Map(), events = new Map(), appearances = new Map();
  function exec(sql, a) {
    if (sql.startsWith("INSERT INTO games")) {
      const [id, team_id, season, format, started_at, ended_at, opponent, us, them, periods, onfield, minsper] = a;
      const ex = games.get(id);
      if (ex) { if (ex.team_id === team_id) Object.assign(ex, { season, ended_at, opponent, us, them }); }
      else games.set(id, { id, team_id, season, format, started_at, ended_at, opponent, us, them, periods, onfield, minsper });
    } else if (sql.includes("INTO game_events")) {
      const [id, game_id, at, period, secs, kind, player_id, detail, gid, team] = a;
      const g = games.get(gid);
      if (g && g.team_id === team && !events.has(id)) events.set(id, { id, game_id, at, period, secs, kind, player_id, detail });
    } else if (sql.includes("INTO appearances")) {
      const [game_id, player_id, period, pos, frac, gid, team] = a;
      const g = games.get(gid);
      if (g && g.team_id === team) appearances.set([game_id, player_id, period, pos].join("|"), { game_id, player_id, period, pos, frac });
    }
  }
  function query(sql, a) {
    if (sql.startsWith("SELECT * FROM games")) {
      const [team, season] = a;
      return [...games.values()]
        .filter((g) => g.team_id === team && (season === undefined || g.season === season))
        .sort((x, y) => y.started_at - x.started_at);
    }
    if (sql.includes("FROM game_events e JOIN games g")) {
      const [gid, team] = a;
      const g = games.get(gid);
      if (!g || g.team_id !== team) return [];
      return [...events.values()].filter((e) => e.game_id === gid).sort((x, y) => x.at - y.at);
    }
    if (sql.includes("FROM appearances")) {
      const [team, season, exclude] = a;
      const ok = (gid) => { const g = games.get(gid); return g && g.team_id === team && g.season === season && gid !== exclude; };
      const grouped = new Map();
      for (const r of appearances.values()) {
        if (!ok(r.game_id)) continue;
        const k = r.player_id + "|" + r.pos;
        grouped.set(k, (grouped.get(k) || 0) + r.frac);
      }
      return [...grouped.entries()].map(([k, sum]) => {
        const [player_id, pos] = k.split("|");
        return { player_id, pos, periods: Math.round(sum * 10) / 10 };
      });
    }
    return [];
  }
  return {
    _games: games, _events: events, _appearances: appearances,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this; },
        async run() { exec(sql, this.args); return { success: true }; },
        async all() { return { results: query(sql, this.args) }; },
        async first() { return query(sql, this.args)[0] || null; },
      };
    },
    async batch(stmts) { for (const s of stmts) await s.run(); return stmts.map(() => ({ success: true })); },
  };
}

const TEAM = "abc123def456";
const OTHER = "zzz999yyy888";
const req = (path, body) => new Request("http://t" + path, body === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const gameRow = (over = {}) => ({
  id: "game0001", season: "Fall 2026", format: "u8", started_at: 1000,
  us: 2, them: 1, periods: 4, onfield: 6, minsper: 10, ...over,
});

test("game row: kickoff insert, full-time upsert", async () => {
  const db = makeDb(), env = { DB: db };
  let r = await worker.fetch(req(`/api/team/${TEAM}/games`, gameRow()), env);
  assert.equal(r.status, 200);
  r = await worker.fetch(req(`/api/team/${TEAM}/games`, gameRow({ ended_at: 5000, us: 3 })), env);
  assert.equal(r.status, 200);
  const g = db._games.get("game0001");
  assert.equal(g.ended_at, 5000);
  assert.equal(g.us, 3);

  r = await worker.fetch(req(`/api/team/${TEAM}/games?season=Fall%202026`), env);
  const list = (await r.json()).games;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "game0001");
});

test("a game row can't be hijacked by another team's token", async () => {
  const db = makeDb(), env = { DB: db };
  await worker.fetch(req(`/api/team/${TEAM}/games`, gameRow()), env);
  await worker.fetch(req(`/api/team/${OTHER}/games`, gameRow({ us: 99 })), env);
  assert.equal(db._games.get("game0001").us, 2, "other team's write bounced off the upsert guard");
});

test("events: idempotent batch append, ownership enforced, ordered read-back", async () => {
  const db = makeDb(), env = { DB: db };
  await worker.fetch(req(`/api/team/${TEAM}/games`, gameRow()), env);
  const evs = [
    { id: "ev0002", game_id: "game0001", at: 200, period: 1, secs: 500, kind: "goal", detail: '{"side":"us","d":1}' },
    { id: "ev0001", game_id: "game0001", at: 100, period: 1, secs: 590, kind: "clock", detail: '{"running":true}' },
  ];
  let r = await worker.fetch(req(`/api/team/${TEAM}/events`, { events: evs }), env);
  assert.equal(r.status, 200);
  r = await worker.fetch(req(`/api/team/${TEAM}/events`, { events: evs }), env); // retry is free
  assert.equal(r.status, 200);
  assert.equal(db._events.size, 2, "INSERT OR IGNORE: no duplicates on retry");

  // a valid token for another team can't write into this game
  await worker.fetch(req(`/api/team/${OTHER}/events`, {
    events: [{ id: "evx0001", game_id: "game0001", at: 1, period: 1, secs: 1, kind: "goal" }],
  }), env);
  assert.equal(db._events.size, 2);

  r = await worker.fetch(req(`/api/team/${TEAM}/games/game0001`), env);
  const got = (await r.json()).events;
  assert.deepEqual(got.map((e) => e.id), ["ev0001", "ev0002"], "ordered by at");
  // and the other team reads nothing
  r = await worker.fetch(req(`/api/team/${OTHER}/games/game0001`), env);
  assert.deepEqual((await r.json()).events, []);
});

test("appearances: keyed upsert, position ratio query, exclude the live game", async () => {
  const db = makeDb(), env = { DB: db };
  await worker.fetch(req(`/api/team/${TEAM}/games`, gameRow()), env);
  await worker.fetch(req(`/api/team/${TEAM}/games`, gameRow({ id: "game0002", started_at: 2000 })), env);
  const rows = [
    { game_id: "game0001", player_id: "p1", period: 1, pos: "D", frac: 1 },
    { game_id: "game0001", player_id: "p1", period: 2, pos: "F", frac: 0.7 },
    { game_id: "game0002", player_id: "p1", period: 1, pos: "D", frac: 1 },
  ];
  await worker.fetch(req(`/api/team/${TEAM}/appearances`, { rows }), env);
  // a sub later in period 2 re-upserts the same key with a new frac
  await worker.fetch(req(`/api/team/${TEAM}/appearances`, {
    rows: [{ game_id: "game0001", player_id: "p1", period: 2, pos: "F", frac: 0.4 }],
  }), env);

  let r = await worker.fetch(req(`/api/team/${TEAM}/positions?season=Fall%202026&exclude=game0002`), env);
  const pos = (await r.json()).positions;
  const d = pos.find((p) => p.player_id === "p1" && p.pos === "D");
  const f = pos.find((p) => p.player_id === "p1" && p.pos === "F");
  assert.equal(d.periods, 1, "the in-progress game is excluded");
  assert.equal(f.periods, 0.4, "upsert replaced the stale frac");
});

test("validation: bad team id, oversized batch, bad pos/period/frac", async () => {
  const env = { DB: makeDb() };
  assert.equal((await worker.fetch(req("/api/team/short/games", gameRow()), env)).status, 400);
  assert.equal((await worker.fetch(req(`/api/team/${TEAM}/games`, { id: "x" }), env)).status, 400);
  assert.equal((await worker.fetch(req(`/api/team/${TEAM}/games`, gameRow({ started_at: 0 })), env)).status, 400);

  const many = Array.from({ length: 501 }, (_, i) => ({ id: "e" + i, game_id: "game0001", kind: "goal" }));
  assert.equal((await worker.fetch(req(`/api/team/${TEAM}/events`, { events: many }), env)).status, 400);
  assert.equal((await worker.fetch(req(`/api/team/${TEAM}/events`, { events: "nope" }), env)).status, 400);

  const bad = (row) => worker.fetch(req(`/api/team/${TEAM}/appearances`, { rows: [row] }), env);
  assert.equal((await bad({ game_id: "game0001", player_id: "p1", period: 1, pos: "M", frac: 1 })).status, 400);
  assert.equal((await bad({ game_id: "game0001", player_id: "p1", period: 0, pos: "D", frac: 1 })).status, 400);
  assert.equal((await bad({ game_id: "game0001", player_id: "p1", period: 1, pos: "D", frac: 9 })).status, 400);
  assert.equal((await bad({ game_id: "game0001", player_id: "", period: 1, pos: "D", frac: 1 })).status, 400);

  assert.equal((await worker.fetch(req(`/api/team/${TEAM}/games/game0001`, {}), env)).status, 405, "POST to an event read");
});
