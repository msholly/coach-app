import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// lineup-core.js is a plain browser script; evaluate it and grab the global.
const src = readFileSync(new URL("../public/lineup-core.js", import.meta.url), "utf8");
const LC = new Function(src + "\nreturn LineupCore;")();

const IDS = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]; // 8 players, the guide's assumed squad

// Mirror of the app.js glue around LineupCore.buildPeriods: sort most-owed
// first (stable), build, tally the plan into the game ledger.
function buildGame(career, opts) {
  const lu = { periods: [], gk: [], actual: {}, gkActual: {}, app: [] };
  const order = IDS.slice().sort((a, b) => (career.played[a] || 0) - (career.played[b] || 0));
  LC.buildPeriods(lu, order, {
    keep: 0, Q: 4, N: opts.N, keeper: opts.keeper,
    kept: career.kept, posTotals: career.posTotals,
  });
  LC.tally(lu, 0, 1);
  return lu;
}
// Mirror of commitGame + the archive's position totals accumulating.
function commit(career, lu) {
  for (const id of Object.keys(lu.actual)) career.played[id] = (career.played[id] || 0) + lu.actual[id];
  for (const id of Object.keys(lu.gkActual)) career.kept[id] = (career.kept[id] || 0) + lu.gkActual[id];
  for (const r of LC.appearanceRows(lu, "g", 4)) {
    const t = (career.posTotals[r.player_id] = career.posTotals[r.player_id] || { GK: 0, D: 0, F: 0 });
    t[r.pos] += r.frac;
  }
}
const freshCareer = () => ({ played: {}, kept: {}, posTotals: {} });

test("posSplit: one keeper, extra body to defense, whole 3–7 range", () => {
  assert.equal(LC.posSplit(3, true), 1);  // GK,D,F
  assert.equal(LC.posSplit(4, true), 2);  // GK,D,D,F
  assert.equal(LC.posSplit(5, true), 2);  // GK,D,D,F,F
  assert.equal(LC.posSplit(6, true), 3);  // GK,D,D,D,F,F
  assert.equal(LC.posSplit(7, true), 3);  // GK,D,D,D,F,F,F
  assert.equal(LC.posSplit(4, false), 2); // BU5 4v4 -> D,D,F,F
  assert.equal(LC.posSplit(3, false), 2); // short-handed keeperless
});

test("three consecutive games: play time within 1, keeper rotates, one keep max per game", () => {
  const career = freshCareer();
  for (let g = 0; g < 3; g++) {
    const lu = buildGame(career, { N: 6, keeper: true });
    // one keeper per period, never twice in a game (finding 1.1's real invariant)
    const gks = lu.gk.filter(Boolean);
    assert.equal(gks.length, 4);
    assert.equal(new Set(gks).size, 4);
    for (const gk of gks) assert.ok(lu.periods[lu.gk.indexOf(gk)].includes(gk), "keeper is on the field");
    commit(career, lu);
  }
  const played = IDS.map((id) => career.played[id] || 0);
  // 24 field-periods per game / 8 players = 3 each, exactly — no drift over 3 games
  assert.equal(Math.max(...played), 9);
  assert.equal(Math.min(...played), 9);
  const kept = IDS.map((id) => career.kept[id] || 0);
  assert.ok(Math.max(...kept) - Math.min(...kept) <= 1, `keeps spread ${kept}`);
});

test("position seeding: right D/F counts each period, everyone sees both over a season", () => {
  const career = freshCareer();
  for (let g = 0; g < 3; g++) {
    const lu = buildGame(career, { N: 6, keeper: true });
    for (let q = 0; q < 4; q++) {
      const es = lu.app[q];
      assert.equal(es.filter((e) => e.pos === "GK").length, 1);
      assert.equal(es.filter((e) => e.pos === "D").length, 3);
      assert.equal(es.filter((e) => e.pos === "F").length, 2);
      assert.equal(es.reduce((a, e) => a + e.frac, 0), 6); // fracs cover the whole period
    }
    commit(career, lu);
  }
  for (const id of IDS) {
    const t = career.posTotals[id];
    assert.ok(t.D > 0, `${id} never played defense: ${JSON.stringify(t)}`);
    assert.ok(t.F > 0, `${id} never played forward: ${JSON.stringify(t)}`);
  }
});

test("keeperless build: no GK anywhere, D/F only (BU5)", () => {
  const lu = buildGame(freshCareer(), { N: 4, keeper: false });
  assert.deepEqual(lu.gk, [null, null, null, null]);
  assert.deepEqual(Object.keys(lu.gkActual), []);
  for (let q = 0; q < 4; q++) {
    assert.equal(lu.app[q].filter((e) => e.pos === "D").length, 2);
    assert.equal(lu.app[q].filter((e) => e.pos === "F").length, 2);
    assert.equal(lu.app[q].some((e) => e.pos === "GK"), false);
  }
});

test("applySub splits the period's credit and moves the position", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  const out = lu.periods[0].find((id) => id !== lu.gk[0]);
  const inn = IDS.find((id) => !lu.periods[0].includes(id));
  const pos = LC.posInPeriod(lu, 0, out);
  const beforeOut = lu.actual[out], beforeIn = lu.actual[inn] || 0; // "inn" plays later periods too
  assert.ok(LC.applySub(lu, 0, out, inn, 0.3));
  assert.equal(Math.round((beforeOut - lu.actual[out]) * 10) / 10, 0.3, "outgoing loses only what they didn't play");
  assert.equal(Math.round((lu.actual[inn] - beforeIn) * 10) / 10, 0.3);
  assert.equal(LC.posInPeriod(lu, 0, inn), pos, "the sub inherits the position");
  assert.equal(lu.periods[0].includes(out), false);
  // the outgoing player keeps the 0.7 they played, at the position they played it
  const row = LC.appearanceRows(lu, "g", 1).find((r) => r.player_id === out);
  assert.equal(row.pos, pos);
  assert.equal(row.frac, 0.7);
});

test("applySub guards: no double-fielding, out must be on the field (finding 1.2 follow-on)", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  const onField = lu.periods[0];
  const bench = IDS.filter((id) => !onField.includes(id));
  assert.equal(LC.applySub(lu, 0, onField[1], onField[2], 0.5), false, "in already on the field");
  assert.equal(LC.applySub(lu, 0, bench[0], bench[1], 0.5), false, "out not on the field");
  assert.equal(new Set(lu.periods[0]).size, 6, "field untouched by rejected subs");
});

test("applySub through the keeper hands over the gloves too", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  const out = lu.gk[0];
  const inn = IDS.find((id) => !lu.periods[0].includes(id));
  const beforeOut = lu.gkActual[out], beforeIn = lu.gkActual[inn] || 0; // "inn" may keep a later period
  assert.ok(LC.applySub(lu, 0, out, inn, 0.4));
  assert.equal(lu.gk[0], inn);
  assert.equal(Math.round((beforeOut - lu.gkActual[out]) * 10) / 10, 0.4);
  assert.equal(Math.round((lu.gkActual[inn] - beforeIn) * 10) / 10, 0.4);
});

test("applyKeeperSwap: the finding-1.2 scenario stays clean", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  const old = lu.gk[0];
  const next = lu.periods[0].find((id) => id !== old);
  const actualBefore = { ...lu.actual };
  assert.ok(LC.applyKeeperSwap(lu, 0, next, 1)); // swap at kickoff
  assert.equal(lu.gk[0], next);
  assert.equal(new Set(lu.periods[0]).size, 6, "six distinct players still on the field");
  assert.deepEqual(lu.actual, actualBefore, "field-time ledger untouched — nobody left");
  assert.equal(lu.gkActual[old] || 0, 0);
  assert.equal(lu.gkActual[next], 1);
  // position ledger: old keeper now holds the new keeper's field spot
  assert.notEqual(LC.posInPeriod(lu, 0, old), "GK");
  assert.equal(LC.posInPeriod(lu, 0, next), "GK");
  // rejects: not on field, same player, no keeper period
  assert.equal(LC.applyKeeperSwap(lu, 0, "nobody", 1), false);
  assert.equal(LC.applyKeeperSwap(lu, 0, next, 1), false);
});

test("mid-period keeper swap splits the goal credit at the clock", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  const old = lu.gk[0];
  const next = lu.periods[0].find((id) => id !== old);
  assert.ok(LC.applyKeeperSwap(lu, 0, next, 0.3)); // 30% of the period left
  assert.equal(Math.round(lu.gkActual[old] * 10) / 10, 0.7);
  assert.equal(Math.round(lu.gkActual[next] * 10) / 10, 0.3);
  const rows = LC.appearanceRows(lu, "g", 1);
  const oldRows = rows.filter((r) => r.player_id === old);
  // one period split across two positions — exactly why pos is in the PK
  assert.deepEqual(oldRows.map((r) => r.pos).sort(), ["GK", oldRows.find((r) => r.pos !== "GK").pos].sort());
  assert.equal(oldRows.reduce((a, r) => a + r.frac, 0), 1);
});

test("applyPosSwap swaps D/F labels, refuses the keeper", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  const es = lu.app[0];
  const d = es.find((e) => e.pos === "D").id;
  const f = es.find((e) => e.pos === "F").id;
  assert.ok(LC.applyPosSwap(lu, 0, d, f));
  assert.equal(LC.posInPeriod(lu, 0, d), "F");
  assert.equal(LC.posInPeriod(lu, 0, f), "D");
  assert.equal(LC.applyPosSwap(lu, 0, lu.gk[0], d), false);
});

test("ensureApp synthesizes a ledger for pre-upgrade docs", () => {
  const lu = {
    periods: [["a", "b", "c", "d", "e", "f"]],
    gk: ["c"],
    actual: {}, gkActual: {},
  };
  LC.ensureApp(lu);
  assert.equal(lu.app.length, 1);
  assert.equal(lu.app[0].find((e) => e.id === "c").pos, "GK");
  assert.equal(lu.app[0].filter((e) => e.pos === "D").length, 3);
  assert.equal(lu.app[0].filter((e) => e.pos === "F").length, 2);
  // short-handed docs push empty periods — must survive
  LC.ensureApp({ periods: [[]], gk: [null], actual: {}, gkActual: {} });
});

test("appearanceRows honours the played-periods cutoff", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  assert.equal(LC.appearanceRows(lu, "g", 1).length, 6);
  assert.equal(LC.appearanceRows(lu, "g", 4).length, 24);
  for (const r of LC.appearanceRows(lu, "g", 2)) {
    assert.ok(r.period >= 1 && r.period <= 2);
    assert.equal(r.game_id, "g");
  }
});

test("positionTotals = archive cache + current game, per decision 6's honest fractions", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  const id = lu.app[0].find((e) => e.pos === "D").id;
  const cached = { [id]: { D: 4.7, F: 1.3 } };
  const tot = LC.positionTotals(lu, cached);
  const inGame = LC.appearanceRows(lu, "g", 4)
    .filter((r) => r.player_id === id && r.pos === "D")
    .reduce((a, r) => a + r.frac, 0);
  assert.equal(Math.round(tot[id].D * 10) / 10, Math.round((4.7 + inGame) * 10) / 10);
});

test("applyFormatOff/On: keeper off mid-period, reversible to the same ledger (t5)", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  lu.keeper = true; // app.js stamps this at build
  const gk = lu.gk[0];
  const off = lu.periods[0].find((id) => id !== gk);
  const snap = {
    actual: { ...lu.actual }, gkActual: { ...lu.gkActual },
    field: lu.periods[0].slice().sort(),
  };
  const res = LC.applyFormatOff(lu, 0, off, 0.4); // 40% of the period left
  assert.ok(res);
  assert.equal(res.gk, gk);
  assert.equal(lu.keeper, false);
  assert.equal(lu.gk[0], null);
  assert.equal(lu.periods[0].includes(off), false);
  assert.equal(lu.periods[0].length, 5);
  // the keeper keeps the goal time already earned and plays out the rest
  assert.equal(Math.round(lu.gkActual[gk] * 10) / 10, 0.6);
  assert.equal(LC.posInPeriod(lu, 0, gk), "D");
  // the benched player keeps what they played
  assert.equal(Math.round((snap.actual[off] - lu.actual[off]) * 10) / 10, 0.4);
  // the undo restores every ledger exactly
  assert.ok(LC.applyFormatOn(lu, 0, off, res.offPos, res.gk, 0.4));
  assert.equal(lu.keeper, true);
  assert.equal(lu.gk[0], gk);
  assert.deepEqual(lu.periods[0].slice().sort(), snap.field);
  for (const id of Object.keys(snap.actual))
    assert.equal(Math.round(lu.actual[id] * 10) / 10, Math.round(snap.actual[id] * 10) / 10, id);
  assert.equal(Math.round(lu.gkActual[gk] * 10) / 10, Math.round(snap.gkActual[gk] * 10) / 10);
  assert.equal(LC.posInPeriod(lu, 0, gk), "GK");
});

test("applyFormatOff: benching the keeper empties the goal", () => {
  const lu = buildGame(freshCareer(), { N: 6, keeper: true });
  lu.keeper = true;
  const gk = lu.gk[0];
  const before = lu.actual[gk];
  const res = LC.applyFormatOff(lu, 0, gk, 0.5);
  assert.ok(res);
  assert.equal(res.gk, gk);
  assert.equal(lu.gk[0], null);
  assert.equal(lu.periods[0].includes(gk), false);
  assert.equal(Math.round(lu.gkActual[gk] * 10) / 10, 0.5);
  assert.equal(Math.round((before - lu.actual[gk]) * 10) / 10, 0.5);
});
