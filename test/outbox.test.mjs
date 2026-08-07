import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// outbox.js is a plain browser script. It reads localStorage and fetch as free
// variables, so evaluating it with those as parameters scopes the fakes to it.
const src = readFileSync(new URL("../public/outbox.js", import.meta.url), "utf8");
const mkOutbox = (localStorage, fetch) =>
  new Function("localStorage", "fetch", src + "\nreturn Outbox;")(localStorage, fetch);

function fakeStore(seed) {
  const m = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    read: (k) => JSON.parse(m.get(k)),
  };
}
const KEY = "team-abc";
const ev = (id) => ({ id, game_id: "g1", kind: "goal", detail: null });
const seeded = (ob) => fakeStore({ [KEY + ":outbox"]: JSON.stringify(ob) });
const ok = { ok: true, json: async () => ({}) };
const bad = { ok: false, status: 500, json: async () => ({}) };

test("load: a missing, corrupt or foreign value falls back to an empty outbox", () => {
  const empty = { games: {}, events: [], appearances: {} };
  assert.deepEqual(mkOutbox(fakeStore(), null).load(KEY), empty);
  assert.deepEqual(mkOutbox(fakeStore({ [KEY + ":outbox"]: "{not json" }), null).load(KEY), empty);
  assert.deepEqual(mkOutbox(fakeStore({ [KEY + ":outbox"]: '{"nope":1}' }), null).load(KEY), empty);
});

test("flush: the game row goes first, then events, then appearances", async () => {
  const store = seeded({
    games: { g1: { id: "g1" } },
    events: [ev("e1")],
    appearances: { "g1|p0|1|D": { game_id: "g1", player_id: "p0", period: 1, pos: "D", frac: 1 } },
  });
  const seen = [];
  const O = mkOutbox(store, async (url) => { seen.push(url.split("/").pop()); return ok; });

  assert.equal(await O.flush(KEY, "/api/team/t"), true);
  assert.deepEqual(seen, ["games", "events", "appearances"]);
  assert.deepEqual(store.read(KEY + ":outbox"), { games: {}, events: [], appearances: {} });
});

// The regression this module exists for: logEvent() writes to the same
// localStorage key, so a snapshot taken before the POST loses whatever the
// coach tapped while it was in flight. A goal really did vanish this way.
test("flush: a row written DURING a POST survives", async () => {
  const store = seeded({ games: {}, events: [ev("e1")], appearances: {} });
  const posted = [];
  let interrupted = false;
  const O = mkOutbox(store, async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith("/events")) {
      posted.push(...body.events.map((e) => e.id));
      if (!interrupted) {
        interrupted = true;                       // the coach taps a goal mid-request
        const ob = store.read(KEY + ":outbox");
        ob.events.push(ev("e-late"));
        store.setItem(KEY + ":outbox", JSON.stringify(ob));
      }
    }
    return ok;
  });

  await O.flush(KEY, "/api/team/t");
  assert.deepEqual(posted, ["e1", "e-late"], "the late row was picked up, not overwritten");
  assert.deepEqual(store.read(KEY + ":outbox").events, []);
});

test("flush: rows clear by id, so an unsent row is never dropped by position", async () => {
  // 250 events = two batches. The second batch fails, and the first must not
  // take the survivors' place in the array with it.
  const events = Array.from({ length: 250 }, (_, i) => ev("e" + i));
  const store = seeded({ games: {}, events, appearances: {} });
  let n = 0;
  const O = mkOutbox(store, async (url) => (url.endsWith("/events") && ++n > 1 ? bad : ok));

  await O.flush(KEY, "/api/team/t");
  const left = store.read(KEY + ":outbox").events;
  assert.equal(left.length, 50, "only the accepted batch cleared");
  assert.deepEqual(left.map((e) => e.id), events.slice(200).map((e) => e.id));
});

test("flush: a failed game row holds its events and appearances back", async () => {
  const store = seeded({
    games: { g1: { id: "g1" } },
    events: [ev("e1")],
    appearances: { "g1|p0|1|D": { game_id: "g1" } },
  });
  const seen = [];
  const O = mkOutbox(store, async (url) => { seen.push(url.split("/").pop()); return bad; });

  await O.flush(KEY, "/api/team/t");
  assert.deepEqual(seen, ["games"], "nothing foreign-keyed to the game was attempted");
  const left = store.read(KEY + ":outbox");
  assert.deepEqual(Object.keys(left.games), ["g1"]);
  assert.equal(left.events.length, 1);
  assert.equal(Object.keys(left.appearances).length, 1);
});

test("flush: a second call while one is in flight is a no-op, and says so", async () => {
  const store = seeded({ games: {}, events: [ev("e1")], appearances: {} });
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const O = mkOutbox(store, async () => { calls++; await gate; return ok; });

  const first = O.flush(KEY, "/api/team/t");
  assert.equal(await O.flush(KEY, "/api/team/t"), false, "re-entrant flush declines");
  release();
  assert.equal(await first, true);
  assert.equal(calls, 1);
  assert.equal(await O.flush(KEY, "/api/team/t"), true, "the guard clears when it finishes");
});

test("flush: a thrown request reports failure and leaves the queue intact", async () => {
  const store = seeded({ games: {}, events: [ev("e1")], appearances: {} });
  const O = mkOutbox(store, async () => { throw new Error("offline"); });

  assert.equal(await O.flush(KEY, "/api/team/t"), false);
  assert.equal(store.read(KEY + ":outbox").events.length, 1);
  // and the guard must not be left stuck on after the throw
  const O2 = mkOutbox(store, async () => ok);
  assert.equal(await O2.flush(KEY, "/api/team/t"), true);
});
