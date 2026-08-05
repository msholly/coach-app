import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// lineup-core.js is a plain browser script; evaluate it and grab the global.
const src = readFileSync(new URL("../public/lineup-core.js", import.meta.url), "utf8");
const LC = new Function(src + "\nreturn LineupCore;")();

const IDS = ["Ana", "Ben", "Cal", "Dev", "Eli", "Fay", "Gus", "Hal", "Ivy"];
const Q = 4, N = 6, MINS = 10, TOTAL = MINS * 60;

function newGame() {
  const lu = { periods: [], gk: [], actual: {}, gkActual: {}, app: [], keeper: true, Q, N };
  LC.buildPeriods(lu, IDS, { keep: 0, Q, N, keeper: true, kept: {}, posTotals: {} });
  return lu;
}

// Mirrors app.js remFrac(): 1 before kickoff, 0 on a break, else what's left.
const rem = (g) => (!g.started ? 1 : g.onBreak ? 0 : Math.min(1, Math.max(0, g.secs / TOTAL)));
// Mirrors app.js curPi().
const curPi = (g) => Math.min(g.period - 1, Q - 1);
const played = (lu, g, id) => LC.playedThrough(lu, curPi(g), id, curPi(g), rem(g));
const mins = (lu, g, id) => Math.round(played(lu, g, id) * MINS);
// What the code did BEFORE this change — the whole-plan sum, kept for the
// convergence assertions.
const planned = (lu, pi, id) => {
  let n = 0;
  (lu.app || []).slice(0, pi + 1).forEach((es) => es.forEach((e) => { if (e.id === id && e.frac > 1e-9) n += e.frac; }));
  return n;
};
const bench = (lu, pi) => IDS.filter((id) => lu.periods[pi].indexOf(id) < 0);

test("kickoff: nobody has played anything", () => {
  const lu = newGame();
  const pre = { started: false, onBreak: false, period: 1, secs: TOTAL };
  for (const id of IDS) assert.equal(played(lu, pre, id), 0, `${id} before kickoff`);

  // and the instant Start is tapped, still zero
  const kick = { started: true, onBreak: false, period: 1, secs: TOTAL };
  for (const id of IDS) assert.equal(played(lu, kick, id), 0, `${id} at kickoff`);

  // the old behaviour, for contrast: everyone on the field read a full period
  for (const id of lu.periods[0]) assert.equal(planned(lu, 0, id), 1);
});

test("the clock, not the plan, moves the number", () => {
  const lu = newGame();
  const onField = lu.periods[0][1];
  const g = { started: true, onBreak: false, period: 1, secs: TOTAL };
  for (const [secs, m] of [[600, 0], [540, 1], [300, 5], [60, 9], [0, 10]]) {
    g.secs = secs;
    assert.equal(mins(lu, g, onField), m, `${secs}s left`);
  }
  // a bench player never moves
  assert.equal(played(lu, g, bench(lu, 0)[0]), 0);
});

test("a sub freezes the outgoing player and starts the incoming one at zero", () => {
  const lu = newGame();
  const g = { started: true, onBreak: false, period: 1, secs: 330 };   // 5:30 left
  const outId = lu.periods[0][1], inId = bench(lu, 0)[0];
  assert.equal(mins(lu, g, outId), 5, "4:30 played before the sub (rounds to 5)");

  assert.ok(LC.applySub(lu, 0, outId, inId, g.secs / TOTAL));
  assert.equal(mins(lu, g, outId), 5, "outgoing frozen at what they played");
  assert.equal(mins(lu, g, inId), 0, "incoming starts at zero, not at their credit");

  g.secs = 210;                                                         // 3:30 left
  assert.equal(mins(lu, g, outId), 5, "still frozen — they are off");
  assert.equal(mins(lu, g, inId), 2, "incoming accrues from the sub, not from kickoff");

  g.secs = 0;
  assert.equal(played(lu, g, outId) + played(lu, g, inId), 1,
    "the two of them account for exactly one period-slot");
});

test("elapsed and planned converge at every period boundary", () => {
  const lu = newGame();
  const g = { started: true, onBreak: false, period: 1, secs: 400 };
  LC.applySub(lu, 0, lu.periods[0][2], bench(lu, 0)[0], 400 / TOTAL);
  LC.applyKeeperSwap(lu, 0, lu.periods[0].find((id) => id !== lu.gk[0]), 250 / TOTAL);

  g.secs = 250;
  const mid = IDS.map((id) => played(lu, g, id));
  assert.ok(mid.some((v, i) => Math.abs(v - planned(lu, 0, IDS[i])) > 1e-9),
    "mid-period they must differ — that is the whole point");

  g.secs = 0;                                                            // the whistle
  for (const id of IDS) {
    assert.ok(Math.abs(played(lu, g, id) - planned(lu, 0, id)) < 1e-9,
      `${id}: elapsed and planned must agree at the boundary`);
  }
});

test("a break credits the period that ended and nothing of the one to come", () => {
  const lu = newGame();
  // period 1 runs out
  let g = { started: true, onBreak: false, period: 1, secs: 0 };
  const p1 = Object.fromEntries(IDS.map((id) => [id, played(lu, g, id)]));
  for (const id of lu.periods[0]) assert.equal(p1[id], 1, `${id} played all of period 1`);

  // the break: g.secs is now the BREAK's countdown, not the period's
  g = { started: true, onBreak: true, period: 1, secs: 150 };
  for (const id of IDS) {
    assert.equal(played(lu, g, id), p1[id], `${id} unchanged during the break`);
  }
  // half-time is longer; still must not leak into anyone's total
  g.secs = 300;
  for (const id of IDS) assert.equal(played(lu, g, id), p1[id]);

  // period 2 starts, clock full: period 2 contributes nothing yet
  g = { started: true, onBreak: false, period: 2, secs: TOTAL };
  for (const id of IDS) assert.equal(played(lu, g, id), p1[id], `${id} at the start of period 2`);
});

test("a full game: totals conserve, and the season archive is untouched", () => {
  const lu = newGame();
  const g = { started: true, onBreak: false, period: 1, secs: TOTAL };
  const log = [];

  for (let p = 1; p <= Q; p++) {
    g.period = p; g.onBreak = false; g.secs = TOTAL;
    const pi = p - 1;
    // one sub partway through every period, plus a keeper swap in period 3
    g.secs = 360;
    LC.applySub(lu, pi, lu.periods[pi].find((id) => id !== lu.gk[pi]), bench(lu, pi)[0], g.secs / TOTAL);
    if (p === 3) {
      g.secs = 200;
      LC.applyKeeperSwap(lu, pi, lu.periods[pi].find((id) => id !== lu.gk[pi]), g.secs / TOTAL);
    }
    g.secs = 0;
    log.push(`P${p}: ` + IDS.map((id) => `${id} ${mins(lu, g, id)}m`).join("  "));

    if (p < Q) { g.onBreak = true; g.secs = 150; }
  }

  // Conservation: every period puts exactly N player-periods on the field.
  g.period = Q; g.onBreak = false; g.secs = 0;
  const total = IDS.reduce((n, id) => n + played(lu, g, id), 0);
  assert.ok(Math.abs(total - Q * N) < 1e-9, `total played ${total}, expected ${Q * N}`);

  // Nobody exceeds the game length, nobody is negative.
  for (const id of IDS) {
    const v = played(lu, g, id);
    assert.ok(v >= 0 && v <= Q + 1e-9, `${id} out of range at ${v}`);
  }

  // The archive is built from the raw fracs, NOT from playedThrough — this
  // change must not move a single row of the season ledger.
  const rows = LC.appearanceRows(lu, "gid1", Q);
  const archived = rows.reduce((n, r) => n + r.frac, 0);
  assert.ok(Math.abs(archived - Q * N) < 1e-9, `archive holds ${archived} period-slots`);
  for (const r of rows) assert.ok(r.frac > 0 && r.frac <= 1, `bad archive frac ${r.frac}`);

  console.log("    " + log.join("\n    "));
});

test("everyone-plays: the guide's 3-of-4 rule still reads true at full time", () => {
  const lu = newGame();
  const g = { started: true, onBreak: false, period: Q, secs: 0 };
  const totals = IDS.map((id) => ({ id, v: played(lu, g, id) }));
  // 9 players, 6 on the field, 4 periods = 24 slots; nobody sits more than once
  const low = Math.min(...totals.map((t) => t.v));
  const high = Math.max(...totals.map((t) => t.v));
  assert.ok(high - low <= 1 + 1e-9, `spread ${low}..${high} — the builder should share within one period`);
});
