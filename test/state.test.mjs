import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// state.js is a plain browser script: it reads LineupCore and localStorage as
// free variables, so evaluating it with those as parameters scopes them to it.
const lcSrc = readFileSync(new URL("../public/lineup-core.js", import.meta.url), "utf8");
const LC = new Function(lcSrc + "\nreturn LineupCore;")();
const src = readFileSync(new URL("../public/state.js", import.meta.url), "utf8");
const mkState = (localStorage) =>
  new Function("LineupCore", "localStorage", src + "\nreturn SaveState;")(LC, localStorage);

const store = (v) => ({ getItem: () => (v === undefined ? null : v), setItem: () => {} });
const S = mkState(store());
const KEY = "ayso-coach-v2:t";

test("defaults: a fresh season is playable and its ledgers are empty", () => {
  const d = S.defaults();
  assert.equal(d.roster.length, 8);
  assert.ok(d.roster.every((p) => p.present && p.id && p.name));
  assert.equal(d.periods, 4);
  assert.equal(d.onfield, 6);
  assert.equal(d.format, "u8");
  assert.deepEqual(d.played, {});
  assert.deepEqual(d.kept, {});
  assert.deepEqual(d.posTotals, {});
  assert.equal(d.lineup, null);
  assert.equal(d.game.period, 1);
  assert.equal(d.game.running, false);
});

test("defaults: each call is a fresh object, not a shared one", () => {
  const a = S.defaults(), b = S.defaults();
  a.roster[0].present = false; a.played.x = 5;
  assert.equal(b.roster[0].present, true);
  assert.deepEqual(b.played, {});
});

test("load: no doc, a corrupt doc, or a doc with no roster all fall back to defaults", () => {
  assert.equal(mkState(store()).load(KEY).roster.length, 8);
  assert.equal(mkState(store("{not json")).load(KEY).roster.length, 8);
  assert.equal(mkState(store('{"team":"Tigers"}')).load(KEY).roster.length, 8);
  // a doc without a roster is not a doc — it must not boot into a broken sheet
  assert.equal(mkState(store('{"team":"Tigers"}')).load(KEY).team, "");
});

test("fixup: a doc from an older version gets every field the app now reads", () => {
  const old = { team: "Tigers", roster: [{ id: "p0", name: "A", present: true }], periods: 4, game: { us: 0, them: 0 } };
  S.fixup(old);
  assert.deepEqual(old.played, {});
  assert.deepEqual(old.kept, {});
  assert.deepEqual(old.posTotals, {});
  assert.equal(old.format, "u8");
  assert.equal(old.season, "Fall 2026");
  assert.equal(old.venue, "home");
  assert.deepEqual(old.game.goals, []);
  assert.deepEqual(old.practiceRun, { startedAt: 0, idx: 0, marks: [] });
});

test("fixup: it fills gaps and never overwrites what is already there", () => {
  const s = {
    roster: [], format: "bu5", season: "Spring 2027", venue: "away",
    played: { p0: 3 }, kept: { p0: 1 }, posTotals: { p0: { GK: 1, D: 2, F: 0 } },
    practiceRun: { startedAt: 99, idx: 2, marks: [1] },
    game: { goals: [{ side: "us" }] },
  };
  S.fixup(s);
  assert.equal(s.format, "bu5");
  assert.equal(s.season, "Spring 2027");
  assert.equal(s.venue, "away");
  assert.deepEqual(s.played, { p0: 3 });
  assert.equal(s.practiceRun.idx, 2);
  assert.equal(s.game.goals.length, 1);
});

test("fixup: venue is home or away, never anything else", () => {
  for (const v of [undefined, "", "neutral", "HOME", null]) {
    const s = { roster: [], venue: v };
    S.fixup(s);
    assert.equal(s.venue, "home", `venue ${JSON.stringify(v)}`);
  }
  const away = { roster: [], venue: "away" };
  S.fixup(away);
  assert.equal(away.venue, "away");
});

test("fixup: a pre-format lineup is a keeper lineup, and gets a position ledger", () => {
  const s = {
    roster: [],
    lineup: { periods: [["p0", "p1", "p2"], ["p0", "p1", "p3"]], gk: ["p0", "p1"], actual: {}, gkActual: {} },
  };
  S.fixup(s);
  assert.equal(s.lineup.keeper, true, "every pre-format lineup was U8");
  assert.equal(s.lineup.app.length, 2, "ensureApp synthesized the ledger");
  assert.equal(LC.posInPeriod(s.lineup, 0, "p0"), "GK");
  const s2 = { roster: [], lineup: { periods: [], gk: [], keeper: false, actual: {}, gkActual: {} } };
  S.fixup(s2);
  assert.equal(s2.lineup.keeper, false, "an explicit keeperless format survives");
});

// Older saves banked the plan straight into the career totals, so the live game
// could not be corrected before it was committed.
test("migrate: the live game moves back out of the career totals", () => {
  const s = {
    roster: [],
    played: { p0: 4, p1: 4 }, kept: { p0: 1 },
    lineup: { periods: [["p0", "p1"], ["p0", "p1"]], gk: ["p0", null] },
  };
  S.migrate(s);
  assert.deepEqual(s.lineup.actual, { p0: 2, p1: 2 }, "this game's periods land in the game ledger");
  assert.deepEqual(s.lineup.gkActual, { p0: 1 });
  assert.deepEqual(s.played, { p0: 2, p1: 2 }, "and come back out of the career totals");
  assert.deepEqual(s.kept, { p0: 0 });
});

test("migrate: career + game still totals what it did before, and only runs once", () => {
  const s = {
    roster: [],
    played: { p0: 4, p1: 4 }, kept: { p0: 1 },
    lineup: { periods: [["p0", "p1"], ["p0", "p1"]], gk: ["p0", null] },
  };
  S.migrate(s);
  const after = JSON.stringify(s);
  assert.equal(s.played.p0 + s.lineup.actual.p0, 4, "no minutes created or destroyed");
  assert.equal(s.kept.p0 + s.lineup.gkActual.p0, 1);
  S.migrate(s);
  assert.equal(JSON.stringify(s), after, "a doc that already has a game ledger is left alone");
});

test("migrate: no lineup is a no-op", () => {
  const s = { roster: [], played: { p0: 4 }, kept: {}, lineup: null };
  S.migrate(s);
  assert.deepEqual(s.played, { p0: 4 });
});

test("load: a real saved doc comes back fixed up and migrated in one pass", () => {
  const saved = JSON.stringify({
    team: "Tigers",
    roster: [{ id: "p0", name: "A", present: true }, { id: "p1", name: "B", present: true }],
    periods: 4, onfield: 6, minsper: 10,
    played: { p0: 2, p1: 2 },
    game: { us: 1, them: 0, period: 2 },
    lineup: { periods: [["p0", "p1"], ["p0", "p1"]], gk: ["p0", "p1"] },
  });
  const s = mkState(store(saved)).load(KEY);
  assert.equal(s.team, "Tigers");
  assert.equal(s.format, "u8");           // fixup ran
  assert.deepEqual(s.played, { p0: 0, p1: 0 });  // migrate ran
  assert.deepEqual(s.lineup.actual, { p0: 2, p1: 2 });
  assert.equal(s.lineup.keeper, true);
  assert.equal(s.lineup.app.length, 2);
});
