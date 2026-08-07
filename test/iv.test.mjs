import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// lineup-core.js is a plain browser script; evaluate it and grab the global.
const src = readFileSync(new URL("../public/lineup-core.js", import.meta.url), "utf8");
const LC = new Function(src + "\nreturn LineupCore;")();

// The 8b interval ledger: lu.iv[q] = { id: [[on, off|null], ...] } — WHERE
// inside a period the minutes happened. Display-only; fairness stays on
// actual/app, which these tests cross-check it against.

const near = (a, b) => Math.abs(a - b) < 1e-9;
function runsOf(lu, q, id) { return ((lu.iv || [])[q] || {})[id] || []; }
function assertRuns(actual, expected, msg) {
  assert.equal(actual.length, expected.length, msg + " (run count " + JSON.stringify(actual) + ")");
  actual.forEach((r, i) => {
    assert.ok(near(r[0], expected[i][0]), msg + " on[" + i + "]=" + r[0]);
    if (expected[i][1] == null) assert.equal(r[1], null, msg + " off[" + i + "] open");
    else assert.ok(near(r[1], expected[i][1]), msg + " off[" + i + "]=" + r[1]);
  });
}
// Σ interval lengths across all players in period q, open/overlong runs capped.
function colSum(lu, q, cap) {
  let n = 0;
  for (const id of Object.keys((lu.iv || [])[q] || {}))
    for (const [a, b] of lu.iv[q][id]) { const e = Math.min(b == null ? cap : b, cap); if (e > a) n += e - a; }
  return n;
}
// Per player: this period's iv total must equal this period's app credit.
function appFrac(lu, q, id) {
  let n = 0;
  for (const e of (lu.app[q] || [])) if (e.id === id && e.frac > 1e-9) n += e.frac;
  return n;
}

// The harness's simulated game: 8 players, 6 on the field, 4 × 10-min periods,
// zero aggregate slack — every kid sits exactly one period.
const SIT = [["Oliver", "Zendrix"], ["Connor", "George"], ["Bearett", "Neel"], ["Jeffrey", "Reyansh"]];
const NAMES = ["Bearett", "Neel", "Jeffrey", "Oliver", "Reyansh", "Zendrix", "Connor", "George"];
function simLu() {
  const lu = {
    Q: 4, N: 6, minsper: 10, keeper: false,
    periods: SIT.map((sit) => NAMES.filter((n) => !sit.includes(n))),
    gk: [null, null, null, null], actual: {}, gkActual: {}, app: [],
  };
  LC.ensureApp(lu);
  LC.tally(lu, 0, 1);
  return lu;
}
// Chronological P1: Reyansh's nosebleed (off 3:00–5:00, Oliver covering) and
// Jeffrey's knee at 6:00 (Zendrix on early). Then Connor on for Neel at 3:00 of P2.
function playToP2(lu) {
  LC.ivOpen(lu, 0);
  assert.ok(LC.applySub(lu, 0, "Reyansh", "Oliver", 0.7));
  assert.ok(LC.applySub(lu, 0, "Oliver", "Reyansh", 0.5));
  assert.ok(LC.applySub(lu, 0, "Jeffrey", "Zendrix", 0.4));
  LC.ivClose(lu, 0);
  LC.ivOpen(lu, 1);
  assert.ok(LC.applySub(lu, 1, "Neel", "Connor", 0.7));
}

test("intervals sit where the minutes happened: injury sub, leave-and-return, open run", () => {
  const lu = simLu();
  playToP2(lu);
  assertRuns(runsOf(lu, 0, "Jeffrey"), [[0, 0.6]], "Jeffrey P1");
  assertRuns(runsOf(lu, 0, "Zendrix"), [[0.6, 1]], "Zendrix P1 gap-then-fill");
  assertRuns(runsOf(lu, 0, "Reyansh"), [[0, 0.3], [0.5, 1]], "Reyansh P1 break in the dark");
  assertRuns(runsOf(lu, 0, "Oliver"), [[0.3, 0.5]], "Oliver P1 cover");
  assertRuns(runsOf(lu, 1, "Connor"), [[0.3, null]], "Connor P2 still on");
  assertRuns(runsOf(lu, 1, "Neel"), [[0, 0.3]], "Neel P2");
});

test("ledger invariants: iv sums equal app credit per player, columns sum to N × elapsed", () => {
  const lu = simLu();
  playToP2(lu);
  // Closed period: every player's interval total is exactly their credited frac.
  for (const id of NAMES) {
    let n = 0;
    for (const [a, b] of runsOf(lu, 0, id)) n += (b == null ? 1 : b) - a;
    assert.ok(near(n, appFrac(lu, 0, id)), id + " P1 iv=" + n + " app=" + appFrac(lu, 0, id));
  }
  assert.ok(near(colSum(lu, 0, 1), 6), "P1 column sums to 6 × 1");
  // Live period at 4:00 (periodT 0.4): the column sums to 6 × elapsed.
  assert.ok(near(colSum(lu, 1, 0.4), 6 * 0.4), "P2 column sums to 6 × 0.4, got " + colSum(lu, 1, 0.4));
});

test("at 4:00 of P2: verdicts read on-from-now for the P1 sitters, nobody short, Connor just on", () => {
  const lu = simLu();
  playToP2(lu);
  const el = 1.4, v = (id) => LC.minVerdict(LC.ivPlayed(lu, id, 1, 0.4), lu.Q, el);
  assert.equal(v("Oliver").k, "on", "Oliver on from now");     // P = 0.2 + 0.4
  assert.equal(v("Zendrix").k, "on", "Zendrix on from now");   // P = 0.4 + 0.4
  for (const id of NAMES) assert.notEqual(v(id).k, "short", id + " must not read short in a working rotation");
  assert.equal(v("Neel").k, "spare");                          // P = 1.3, slack 0.9
  assert.ok(near(LC.ivPlayed(lu, "Connor", 1, 0.4), 1.1), "Connor P");
  // Freshness badge: on since 0.3, one minute ago — clears after 2:00 of clock.
  assert.ok(LC.ivJustOn(lu, "Connor", 1, 0.4, 10), "Connor wears just-on at 1:00");
  assert.ok(!LC.ivJustOn(lu, "Connor", 1, 0.51, 10), "badge clears past 2:00");
  assert.ok(!LC.ivJustOn(lu, "Bearett", 1, 0.4, 10), "a period-start player is not just-on");
});

test("full time: Jeffrey's knee reads short 0.4p, the rest of the rotation met its minimum", () => {
  const lu = simLu();
  playToP2(lu);
  LC.ivClose(lu, 1);
  LC.ivOpen(lu, 2); LC.ivClose(lu, 2);
  LC.ivOpen(lu, 3); LC.ivClose(lu, 3);
  const v = (id) => LC.minVerdict(LC.ivPlayed(lu, id, 3, 1), lu.Q, 4);
  // Zero aggregate slack means every mid-period absence becomes a deficit the
  // verdict must surface: Jeffrey's knee (2.6), Neel's tired stretch (2.3),
  // Reyansh's nosebleed (2.8). The cover players banked what they lost.
  const shorts = { Jeffrey: "short 0.4p", Neel: "short 0.7p", Reyansh: "short 0.2p" };
  for (const id of NAMES) {
    if (shorts[id]) assert.equal(v(id).label, shorts[id], id);
    else assert.equal(v(id).k, "met", id + " met");
  }
  for (let q = 0; q < 4; q++) assert.ok(near(colSum(lu, q, 1), 6), "P" + (q + 1) + " column sums to 6");
});

test("late arrival: short fires the moment P2 runs without them, not at full time", () => {
  const six = NAMES.slice(0, 6);
  const lu = {
    Q: 4, N: 6, minsper: 10, keeper: false,
    periods: [six, six, six, six], gk: [null, null, null, null],
    actual: {}, gkActual: {}, app: [],
  };
  LC.ensureApp(lu);
  LC.ivOpen(lu, 0); LC.ivClose(lu, 0);
  // At the P2 break (el = 1.0) three periods are still reachable — no pill yet.
  assert.equal(LC.minVerdict(LC.ivPlayed(lu, "Late", 0, 1), 4, 1).k, "on");
  LC.ivOpen(lu, 1);
  // Six seconds into P2 they are still not on: 3 of 4 just became unreachable.
  const vd = LC.minVerdict(LC.ivPlayed(lu, "Late", 1, 0.01), 4, 1.01);
  assert.equal(vd.k, "short");
  assert.equal(vd.label, "short 0p");   // r1(0.01) — the deficit grows from here
});

test("older docs: ensureIv synthesizes whole-period runs and a live-period sub still splits", () => {
  const lu = simLu();          // app exists, no iv — the pre-8b shape
  LC.ensureIv(lu, 2);          // two periods started
  assert.equal(lu.iv.length, 2);
  assertRuns(runsOf(lu, 0, "Bearett"), [[0, 1]], "synthesized P1");
  assert.equal(runsOf(lu, 0, "Oliver").length, 0, "sitters with no app credit get no run");
  // The synthesized live period has no open run; ivSub trims the whole-period one.
  assert.ok(LC.applySub(lu, 1, "Neel", "Connor", 0.5));
  assertRuns(runsOf(lu, 1, "Neel"), [[0, 0.5]], "Neel trimmed at the split");
  assertRuns(runsOf(lu, 1, "Connor"), [[0.5, null]], "Connor opens at the split");
  // ivPlayed clamps a synthesized [0,1] in the live period to the clock.
  assert.ok(near(LC.ivPlayed(lu, "Bearett", 1, 0.4), 1.4), "clamped at periodT");
  LC.ivTruncate(lu, 1);
  assert.equal(lu.iv.length, 1);
});
