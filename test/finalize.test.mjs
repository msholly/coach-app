import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// lineup-core.js is a plain browser script; evaluate it and grab the global.
const src = readFileSync(new URL("../public/lineup-core.js", import.meta.url), "utf8");
const LC = new Function(src + "\nreturn LineupCore;")();

const IDS = ["Ana", "Ben", "Cal", "Dev", "Eli", "Fay", "Gus", "Hal", "Ivy"];
const Q = 4, N = 6, MINS = 10;

function newGame() {
  const lu = { periods: [], gk: [], actual: {}, gkActual: {}, app: [], keeper: true, Q, N };
  LC.buildPeriods(lu, IDS, { keep: 0, Q, N, keeper: true, kept: {}, posTotals: {} });
  // app.js seeds the career ledger by tallying every planned period +1 at build
  // time (app.js buildLineup: `tally(lu,keep,1)`). That seed is the whole leak:
  // commitGame later banks it verbatim, future periods and all.
  LC.tally(lu, 0, 1);
  return lu;
}
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test("early finish: career banks only elapsed, archive clips the live period", () => {
  const lu = newGame();
  assert.equal(sum(lu.actual), Q * N, "seeded plan holds all 24 player-periods");

  // Game ends in period 2 at 4:00 elapsed → 6:00 left → rem 0.6, live index 1.
  LC.finalizeAtElapsed(lu, 1, 0.6);

  // Career (lu.actual → commitGame) reflects only what was played:
  // P1 in full, P2 at 0.4, P3/P4 gone.
  const p1 = lu.periods[0], p2 = lu.periods[1];
  const expected = p1.length * 1 + p2.length * 0.4;
  assert.ok(Math.abs(sum(lu.actual) - expected) < 1e-9,
    `career banked ${sum(lu.actual)}, expected ${expected}`);

  // Per player, the career bank must be exactly their P1 + clipped-P2 time and
  // nothing from the unplayed future — the bug credited whole periods P3/P4.
  for (const id of IDS) {
    const want = (p1.indexOf(id) >= 0 ? 1 : 0) + (p2.indexOf(id) >= 0 ? 0.4 : 0);
    assert.ok(Math.abs((lu.actual[id] || 0) - want) < 1e-9,
      `${id} banked ${lu.actual[id] || 0}, expected ${want}`);
  }

  // Archive: closeGameRow writes appearanceRows up to the current period.
  const rows = LC.appearanceRows(lu, "gid", Math.min(2, Q));
  assert.ok(rows.every((r) => r.period === 1 || r.period === 2), "no P3/P4 rows archived");
  for (const r of rows) {
    if (r.period === 1) assert.ok(Math.abs(r.frac - 1) < 1e-9, `P1 ${r.player_id} full`);
    if (r.period === 2) assert.ok(Math.abs(r.frac - 0.4) < 1e-9, `P2 ${r.player_id} clipped to 0.4`);
  }
});

test("normal full time is byte-identical: rem=0 finalize changes nothing", () => {
  const a = newGame();
  const b = newGame();
  // b finalized at true full time — last period, clock at 0.
  LC.finalizeAtElapsed(b, Q - 1, 0);
  assert.deepEqual(b.actual, a.actual, "career ledger unchanged at full time");
  assert.deepEqual(b.gkActual, a.gkActual, "keeper ledger unchanged at full time");
  assert.deepEqual(
    LC.appearanceRows(b, "gid", Q),
    LC.appearanceRows(a, "gid", Q),
    "archive rows unchanged at full time");
});
