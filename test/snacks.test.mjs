import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

/* The snack sign-up board: a second capability link beside the team token.
   The D1 stand-in dispatches on SQL text over three tables (teams, snack_boards,
   snack_signups) and models the two conditional writes the worker relies on —
   the claim-guarded UPSERT and the claim-guarded DELETE — through meta.changes. */
function makeD1() {
  const teams = new Map(), boards = new Map(), signups = new Map();
  const skey = (b, u) => b + "|" + u;
  return {
    _teams: teams, _boards: boards, _signups: signups,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this; },
        async first() {
          const a = this.args;
          if (/FROM teams WHERE id = \?/.test(sql)) { const r = teams.get(a[0]); return r ? { ...r } : null; }
          if (/SELECT id FROM snack_boards WHERE team_id = \?/.test(sql)) {
            for (const b of boards.values()) if (b.team_id === a[0]) return { id: b.id };
            return null;
          }
          if (/SELECT team_id FROM snack_boards WHERE id = \?/.test(sql)) { const b = boards.get(a[0]); return b ? { team_id: b.team_id } : null; }
          throw new Error("unmodelled first(): " + sql);
        },
        async all() {
          if (/FROM snack_signups WHERE board_id = \?/.test(sql)) {
            const out = [...signups.values()].filter((r) => r.board_id === this.args[0]).sort((x, y) => x.created_at - y.created_at);
            return { results: out.map((r) => ({ ...r })) };
          }
          throw new Error("unmodelled all(): " + sql);
        },
        async run() {
          const a = this.args;
          if (/INSERT INTO snack_boards/.test(sql)) {
            for (const b of boards.values()) if (b.team_id === a[1]) return { success: true, meta: { changes: 0 } };
            boards.set(a[0], { id: a[0], team_id: a[1], created_at: a[2] });
            return { success: true, meta: { changes: 1 } };
          }
          if (/INSERT INTO snack_signups/.test(sql)) {
            const [board_id, event_uid, name, note, claim, created_at] = a;
            const k = skey(board_id, event_uid), ex = signups.get(k);
            if (!ex) { signups.set(k, { board_id, event_uid, name, note, claim, created_at }); return { success: true, meta: { changes: 1 } }; }
            if (ex.claim !== claim) return { success: true, meta: { changes: 0 } };
            Object.assign(ex, { name, note });
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE teams SET ics_url = NULL WHERE id = \?/.test(sql)) {
            const t = teams.get(a[0]); if (t) t.ics_url = null;
            return { success: true, meta: { changes: t ? 1 : 0 } };
          }
          if (/UPDATE teams SET ics_url = \? WHERE id = \?/.test(sql)) {
            const t = teams.get(a[1]); if (t) t.ics_url = a[0];
            return { success: true, meta: { changes: t ? 1 : 0 } };
          }
          if (/DELETE FROM snack_signups WHERE board_id = \? AND event_uid = \? AND claim = \?/.test(sql)) {
            const k = skey(a[0], a[1]), ex = signups.get(k);
            if (!ex || ex.claim !== a[2]) return { success: true, meta: { changes: 0 } };
            signups.delete(k);
            return { success: true, meta: { changes: 1 } };
          }
          if (/DELETE FROM snack_signups WHERE board_id = \? AND event_uid = \?/.test(sql)) {
            const had = signups.delete(skey(a[0], a[1]));
            return { success: true, meta: { changes: had ? 1 : 0 } };
          }
          throw new Error("unmodelled run(): " + sql);
        },
      };
    },
  };
}

// Two games and a practice, the way GameChanger publishes them. The practice
// has no "vs"/"@", so it must never appear on the board.
const ICS = [
  "BEGIN:VCALENDAR", "X-WR-CALNAME:Fall 2026 BU5",
  "BEGIN:VEVENT", "UID:g1@gc.com", "DTSTART:20260912T150000Z", "DTEND:20260912T160000Z", "SUMMARY:Fall 2026 BU5 @ Jones", "LOCATION:Trabuco Mesa 4", "END:VEVENT",
  "BEGIN:VEVENT", "UID:p1@gc.com", "DTSTART:20261024T150000Z", "DTEND:20261024T160000Z", "SUMMARY:Practice", "LOCATION:Trabuco Mesa 6", "END:VEVENT",
  "BEGIN:VEVENT", "UID:g2@gc.com", "DTSTART:20260926T150000Z", "DTEND:20260926T160000Z", "SUMMARY:Fall 2026 BU5 vs DiRocco", "LOCATION:Trabuco Mesa 4", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

// A second team's feed, for the multi-team tests: different games entirely.
const ICS_B = [
  "BEGIN:VCALENDAR", "X-WR-CALNAME:Fall 2026 U8",
  "BEGIN:VEVENT", "UID:b1@gc.com", "DTSTART:20260913T150000Z", "DTEND:20260913T160000Z", "SUMMARY:Fall 2026 U8 vs Rangers", "LOCATION:Field 2", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const realFetch = globalThis.fetch;
const fetched = [];
before(() => {
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (/notacal/.test(String(url))) return new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
    const body = /teamB/.test(String(url)) ? ICS_B : ICS;
    return new Response(body, { status: 200, headers: { "content-type": "text/calendar" } });
  };
});
after(() => { globalThis.fetch = realFetch; });

const TEAM = "abc123def456";
const DOC = JSON.stringify({ team: "Thunder", season: "Fall 2026", roster: [{ id: "s0", name: "Oliver" }] });
const CLAIM_A = "claimA_0123456789abcdef", CLAIM_B = "claimB_0123456789abcdef";

function env(opts = {}) {
  const DB = makeD1();
  DB._teams.set(TEAM, { id: TEAM, doc: DOC, rev: 1, updated_at: 1, created_at: 1, pass_hash: opts.pass_hash || null });
  return { DB, GC_ICS_URL: "https://gc.example/cal.ics?token=SECRET" };
}
const req = (path, opts) => new Request("http://t" + path, opts);
const jsonReq = (path, method, body) => req(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function mint(e) {
  const r = await worker.fetch(req(`/api/team/${TEAM}/snacks`, { method: "POST" }), e);
  assert.equal(r.status, 200);
  return (await r.json()).board;
}
const board = (e, b, claim) => worker.fetch(req(`/api/snacks/${b}` + (claim ? `?claim=${claim}` : "")), e).then((r) => r.json());

test("the coach mints one board per team; a second POST returns the same link", async () => {
  const e = env();
  const b1 = await mint(e), b2 = await mint(e);
  assert.match(b1, /^[A-Za-z0-9_-]{8,64}$/, "a board id has the team-id shape");
  assert.equal(b1, b2);
  assert.notEqual(b1, TEAM, "the board is never the team token");
  const s = await (await worker.fetch(req(`/api/team/${TEAM}/snacks`), e)).json();
  assert.deepEqual(s, { board: b1, signups: [] });
});

test("before minting, the coach view reports no board", async () => {
  const e = env();
  const s = await (await worker.fetch(req(`/api/team/${TEAM}/snacks`), e)).json();
  assert.deepEqual(s, { board: null, signups: [] });
});

test("a board for a team that does not exist is a 404", async () => {
  const e = env();
  const r = await worker.fetch(req(`/api/team/zzz999yyy888/snacks`, { method: "POST" }), e);
  assert.equal(r.status, 404);
});

test("the public board lists games only, with the team name and no roster", async () => {
  const e = env();
  const b = await mint(e);
  const d = await board(e, b);
  assert.equal(d.team, "Thunder");
  assert.equal(d.season, "Fall 2026");
  assert.equal(d.calendar, "Fall 2026 BU5");
  assert.deepEqual(d.events.map((x) => x.uid), ["g1@gc.com", "g2@gc.com"], "sorted by date, practice skipped");
  assert.deepEqual(d.events.map((x) => [x.venue, x.opponent]), [["away", "Jones"], ["home", "DiRocco"]]);
  assert.ok(d.events.every((x) => x.signup === null));
  assert.equal("roster" in d, false);
});

test("an unknown board id is a 404, a malformed one a 400", async () => {
  const e = env();
  assert.equal((await worker.fetch(req(`/api/snacks/nosuchboard0`), e)).status, 404);
  assert.equal((await worker.fetch(req(`/api/snacks/bad`), e)).status, 400);
});

test("a parent takes a game; the board shows who, and `mine` only for their claim", async () => {
  const e = env();
  const b = await mint(e);
  let r = await worker.fetch(jsonReq(`/api/snacks/${b}/g1@gc.com`, "PUT", { name: "Sholly family", note: "orange slices", claim: CLAIM_A }), e);
  assert.equal(r.status, 200);

  const mine = await board(e, b, CLAIM_A);
  assert.equal(mine.events[0].signup.name, "Sholly family");
  assert.equal(mine.events[0].signup.note, "orange slices");
  assert.equal(mine.events[0].signup.mine, true);
  assert.equal(typeof mine.events[0].signup.at, "number");
  assert.equal("claim" in mine.events[0].signup, false, "the claim never leaves the server");

  const other = await board(e, b, CLAIM_B);
  assert.equal(other.events[0].signup.name, "Sholly family", "everyone sees who took it");
  assert.equal(other.events[0].signup.mine, false);

  const anon = await board(e, b);
  assert.equal(anon.events[0].signup.mine, false);
});

test("a taken game is a 409 for a different claim; the same claim can change its own signup", async () => {
  const e = env();
  const b = await mint(e);
  await worker.fetch(jsonReq(`/api/snacks/${b}/g1@gc.com`, "PUT", { name: "Sholly family", claim: CLAIM_A }), e);
  let r = await worker.fetch(jsonReq(`/api/snacks/${b}/g1@gc.com`, "PUT", { name: "Jones family", claim: CLAIM_B }), e);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "taken");

  r = await worker.fetch(jsonReq(`/api/snacks/${b}/g1@gc.com`, "PUT", { name: "The Shollys", note: "juice boxes", claim: CLAIM_A }), e);
  assert.equal(r.status, 200);
  const d = await board(e, b);
  assert.equal(d.events[0].signup.name, "The Shollys");
  assert.equal(d.events[0].signup.note, "juice boxes");
});

test("only the claim that took a game can give it back", async () => {
  const e = env();
  const b = await mint(e);
  await worker.fetch(jsonReq(`/api/snacks/${b}/g2@gc.com`, "PUT", { name: "Sholly family", claim: CLAIM_A }), e);
  let r = await worker.fetch(jsonReq(`/api/snacks/${b}/g2@gc.com`, "DELETE", { claim: CLAIM_B }), e);
  assert.equal(r.status, 404, "someone else's slot looks like no slot at all");
  assert.equal((await board(e, b)).events[1].signup.name, "Sholly family", "still taken");

  r = await worker.fetch(jsonReq(`/api/snacks/${b}/g2@gc.com`, "DELETE", { claim: CLAIM_A }), e);
  assert.equal(r.status, 200);
  assert.equal((await board(e, b)).events[1].signup, null);
});

test("the coach can clear any slot without a claim", async () => {
  const e = env();
  const b = await mint(e);
  await worker.fetch(jsonReq(`/api/snacks/${b}/g1@gc.com`, "PUT", { name: "Sholly family", claim: CLAIM_A }), e);
  const r = await worker.fetch(req(`/api/team/${TEAM}/snacks/g1@gc.com`, { method: "DELETE" }), e);
  assert.equal(r.status, 200);
  assert.equal((await board(e, b)).events[0].signup, null);
});

test("bad writes are rejected at the boundary", async () => {
  const e = env();
  const b = await mint(e);
  const put = (uid, body) => worker.fetch(jsonReq(`/api/snacks/${b}/${uid}`, "PUT", body), e);
  assert.equal((await put("g1@gc.com", { name: "", claim: CLAIM_A })).status, 400, "a name is required");
  assert.equal((await put("g1@gc.com", { name: "X", claim: "short" })).status, 400, "a claim has a minimum length");
  assert.equal((await put("nope@gc.com", { name: "X", claim: CLAIM_A })).status, 404, "only a scheduled game can be taken");
  assert.equal((await put("p1@gc.com", { name: "X", claim: CLAIM_A })).status, 404, "a practice is not a snack game");
  const r = await worker.fetch(req(`/api/snacks/${b}/g1@gc.com`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{" }), e);
  assert.equal(r.status, 400);
  assert.equal((await worker.fetch(jsonReq(`/api/snacks/${b}/g1@gc.com`, "PUT", { name: "Sholly family", claim: CLAIM_A }), e)).status, 200);
  assert.equal((await board(e, b)).events[0].signup.note, null, "a missing note is null, not an empty string");
});

test("name and note are capped, not rejected, when too long", async () => {
  const e = env();
  const b = await mint(e);
  const r = await worker.fetch(jsonReq(`/api/snacks/${b}/g1@gc.com`, "PUT", { name: "N".repeat(200), note: "n".repeat(500), claim: CLAIM_A }), e);
  assert.equal(r.status, 200);
  const s = (await board(e, b)).events[0].signup;
  assert.equal(s.name.length, 60);
  assert.equal(s.note.length, 140);
});

test("a locked team's board still works for parents with no cookie, while the coach routes stay gated", async () => {
  const e = env();
  const b = await mint(e);                        // minted while unlocked
  e.DB._teams.get(TEAM).pass_hash = "pbkdf2$10000$AAAA$BBBB";   // then the coach adds a passphrase
  const d = await board(e, b);
  assert.equal(d.events.length, 2, "the board is its own gate");
  assert.equal((await worker.fetch(jsonReq(`/api/snacks/${b}/g1@gc.com`, "PUT", { name: "X", claim: CLAIM_A }), e)).status, 200);
  assert.equal((await worker.fetch(req(`/api/team/${TEAM}/snacks`), e)).status, 401);
  assert.equal((await worker.fetch(req(`/api/team/${TEAM}/snacks/g1@gc.com`, { method: "DELETE" }), e)).status, 401);
});

test("without a schedule feed the board says so rather than showing nothing", async () => {
  const e = env();
  const b = await mint(e);
  delete e.GC_ICS_URL;
  const r = await worker.fetch(req(`/api/snacks/${b}`), e);
  assert.equal(r.status, 501);
  assert.equal((await r.json()).error, "schedule_unavailable");
});

test("the public write path is rate limited per board and caller", async () => {
  const e = env();
  const b = await mint(e);
  const keys = [];
  e.LOGIN_LIMIT = { async limit({ key }) { keys.push(key); return { success: false }; } };
  const r = await worker.fetch(req(`/api/snacks/${b}/g1@gc.com`, {
    method: "PUT", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({ name: "X", claim: CLAIM_A }),
  }), e);
  assert.equal(r.status, 429);
  assert.deepEqual(keys, [`snack:${b}:203.0.113.9`]);
});

test("the coach's own schedule route is unchanged by the refactor (practice included)", async () => {
  const e = env();
  const r = await worker.fetch(req(`/api/team/${TEAM}/schedule`), e);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, max-age=300");
  const d = await r.json();
  assert.equal(d.calendar, "Fall 2026 BU5");
  assert.equal(d.source, "global");
  assert.deepEqual(d.events.map((x) => x.uid), ["g1@gc.com", "g2@gc.com", "p1@gc.com"]);
});

/* ---------- multiple teams: one feed and one board per team ---------- */
const TEAM_B = "teamB_987654321";
const DOC_B = JSON.stringify({ team: "Rockets", season: "Fall 2026", roster: [] });
function twoTeams() {
  const e = env();
  e.DB._teams.set(TEAM_B, { id: TEAM_B, doc: DOC_B, rev: 1, updated_at: 1, created_at: 1, pass_hash: null });
  return e;
}
const putFeed = (e, team, url) => worker.fetch(jsonReq(`/api/team/${team}/schedule`, "PUT", { url }), e);

test("two teams get two different boards, each titled for its own team", async () => {
  const e = twoTeams();
  const bA = await mint(e);
  const rB = await worker.fetch(req(`/api/team/${TEAM_B}/snacks`, { method: "POST" }), e);
  const bB = (await rB.json()).board;
  assert.notEqual(bA, bB);
  assert.equal((await board(e, bA)).team, "Thunder");
  assert.equal((await board(e, bB)).team, "Rockets");
});

test("a team connects its own GameChanger feed; its board and schedule use it, the other team keeps the global one", async () => {
  const e = twoTeams();
  const bA = await mint(e);
  const bB = (await (await worker.fetch(req(`/api/team/${TEAM_B}/snacks`, { method: "POST" }), e)).json()).board;

  const r = await putFeed(e, TEAM_B, "webcal://gc.example/teamB.ics?token=SECRET_B");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, { connected: true, source: "team", calendar: "Fall 2026 U8", games: 1 });
  assert.equal(JSON.stringify(j).includes("SECRET_B"), false, "the feed URL is never echoed");
  assert.match(fetched[fetched.length - 1], /^https:\/\/gc\.example\/teamB\.ics/, "webcal:// is fetched as https://");

  assert.deepEqual((await board(e, bB)).events.map((x) => x.uid), ["b1@gc.com"], "team B's board is team B's games");
  assert.deepEqual((await board(e, bA)).events.map((x) => x.uid), ["g1@gc.com", "g2@gc.com"], "team A still falls back to the secret");

  const sB = await (await worker.fetch(req(`/api/team/${TEAM_B}/schedule`), e)).json();
  assert.equal(sB.source, "team");
  assert.equal(sB.calendar, "Fall 2026 U8");
  const sA = await (await worker.fetch(req(`/api/team/${TEAM}/schedule`), e)).json();
  assert.equal(sA.source, "global");

  // A signup on team B is checked against team B's feed, not the global one.
  assert.equal((await worker.fetch(jsonReq(`/api/snacks/${bB}/b1@gc.com`, "PUT", { name: "Rocket parent", claim: CLAIM_A }), e)).status, 200);
  assert.equal((await worker.fetch(jsonReq(`/api/snacks/${bB}/g1@gc.com`, "PUT", { name: "Rocket parent", claim: CLAIM_A }), e)).status, 404);
});

test("a team's own feed works with no global secret at all, and disconnecting falls back to whatever is left", async () => {
  const e = twoTeams();
  delete e.GC_ICS_URL;
  const bB = (await (await worker.fetch(req(`/api/team/${TEAM_B}/snacks`, { method: "POST" }), e)).json()).board;
  assert.equal((await worker.fetch(req(`/api/snacks/${bB}`), e)).status, 501);
  assert.equal((await putFeed(e, TEAM_B, "https://gc.example/teamB.ics")).status, 200);
  assert.equal((await board(e, bB)).events.length, 1);

  const r = await putFeed(e, TEAM_B, null);
  assert.deepEqual(await r.json(), { connected: false, source: null });
  assert.equal((await worker.fetch(req(`/api/snacks/${bB}`), e)).status, 501);
});

test("a feed link is validated before it is stored", async () => {
  const e = env();
  assert.equal((await putFeed(e, TEAM, "ftp://gc.example/x.ics")).status, 400);
  assert.equal((await putFeed(e, TEAM, "not a url")).status, 400);
  assert.equal((await putFeed(e, TEAM, "https://gc.example/notacal")).status, 502, "a page that is not a calendar is refused");
  assert.equal(e.DB._teams.get(TEAM).ics_url, undefined, "nothing was stored");
  assert.equal((await putFeed(e, "zzz999yyy888", "https://gc.example/x.ics")).status, 404);
});

test("the feed URL never leaks through the team document route", async () => {
  const e = env();
  await putFeed(e, TEAM, "https://gc.example/teamA.ics?token=SECRET_A");
  const body = await (await worker.fetch(req(`/api/team/${TEAM}`), e)).text();
  assert.equal(body.includes("SECRET_A"), false);
  assert.equal(body.includes("ics_url"), false);
});
