import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// lineup-core.js is a plain browser script; evaluate it and grab the global.
const src = readFileSync(new URL("../public/lineup-core.js", import.meta.url), "utf8");
const LC = new Function(src + "\nreturn LineupCore;")();

/* Does a child get credit for a period nobody has played yet?
   buildPeriods() stamps every planned period frac:1 and tally() adds +1 for the
   whole game, so lu.actual / lu.gkActual / lu.app are PROJECTIONS. The Game Day
   surfaces a coach makes a split-second call off — the D/F strip on a chip, the
   "Never in goal" pill — must read banked time instead. These tests drive a
   whole typical U8 game through the same wrappers app.js uses. */

const IDS = ["Ana", "Ben", "Cal", "Dev", "Eli", "Fay", "Gus", "Hal", "Ivy"];
const Q = 4, N = 6, MINS = 10, TOTAL = MINS * 60;

// ---- the app.js wrappers, mirrored exactly (app.js:948, :363, :252, :255) ----
const remFrac = (g) => (!g.started ? 1 : g.onBreak ? 0 : Math.min(1, Math.max(0, g.secs / TOTAL)));
const curPi = (g) => Math.min(g.period - 1, Q - 1);
const played = (lu, g, id) => LC.playedThrough(lu, curPi(g), id, curPi(g), remFrac(g));
const totKept = (kept, lu, g, id) =>
  (kept[id] || 0) + (lu ? LC.playedThrough(lu, curPi(g), id, curPi(g), remFrac(g), "GK") : 0);
const posTotals = (lu, cached, g) =>
  LC.positionTotals(lu, cached, curPi(g) + 1, curPi(g), remFrac(g));
// What the code did BEFORE this change, kept for the contrast assertions.
const oldKept = (kept, lu, id) => (kept[id] || 0) + (lu.gkActual[id] || 0);
const oldPos = (lu, cached) => LC.positionTotals(lu, cached);

function newGame(kept = {}, posTot = {}) {
  const lu = { periods: [], gk: [], actual: {}, gkActual: {}, app: [], keeper: true, Q, N, minsper: MINS };
  LC.buildPeriods(lu, IDS, { keep: 0, Q, N, keeper: true, kept, posTotals: posTot });
  LC.tally(lu, 0, 1);   // app.js buildLineup does this — it is what makes lu.actual a projection
  return lu;
}
const bench = (lu, pi) => IDS.filter((id) => lu.periods[pi].indexOf(id) < 0);
const r1 = (v) => Math.round(v * 10) / 10;
// The chip's D/F strip: a ratio, so a phantom period skews it even when small.
const dfStrip = (t) => {
  const d = (t && t.D) || 0, f = (t && t.F) || 0, tot = d + f;
  return tot ? { d: Math.round(d / tot * 100), f: Math.round(f / tot * 100) } : { d: 0, f: 0 };
};

test("before kickoff nobody has kept goal, however the sheet is drawn", () => {
  const lu = newGame();
  const pre = { started: false, onBreak: false, period: 1, secs: TOTAL };

  for (const id of IDS) {
    assert.equal(totKept({}, lu, pre, id), 0, `${id} has kept nothing before the whistle`);
    assert.deepEqual(dfStrip(posTotals(lu, {}, pre)[id]), { d: 0, f: 0 }, `${id}'s strip is empty`);
  }
  // The contrast: every keeper the plan names already read a full period in goal.
  const scheduled = lu.gk.filter(Boolean);
  assert.ok(scheduled.length === Q, "the builder named a keeper for all four periods");
  for (const id of scheduled) assert.equal(oldKept({}, lu, id), 1, `${id} was pre-credited`);
});

test("the P4 keeper still counts as never-in-goal until P4 actually runs", () => {
  const lu = newGame();
  const p4gk = lu.gk[3];
  assert.ok(p4gk && lu.gk.slice(0, 3).indexOf(p4gk) < 0, "P4 has its own keeper");

  // The pill's condition, straight out of app.js:1342 — kept < 0.05.
  const neverInGoal = (g) => totKept({}, lu, g, p4gk) < 0.05;

  assert.ok(neverInGoal({ started: true, onBreak: false, period: 1, secs: 0 }), "end of P1");
  assert.ok(neverInGoal({ started: true, onBreak: true, period: 2, secs: 150 }), "the half-time break");
  assert.ok(neverInGoal({ started: true, onBreak: false, period: 3, secs: 0 }), "end of P3");
  assert.ok(neverInGoal({ started: true, onBreak: false, period: 4, secs: TOTAL }), "P4 kickoff");
  // ...and the moment the clock runs on P4, it clears.
  assert.ok(!neverInGoal({ started: true, onBreak: false, period: 4, secs: TOTAL - 60 }), "one minute in");

  assert.ok(oldKept({}, lu, p4gk) >= 1, "the old number silenced the pill from the first whistle");
});

test("goal time accrues with the clock and freezes on a swap", () => {
  const lu = newGame();
  const g = { started: true, onBreak: false, period: 1, secs: TOTAL };
  const gk1 = lu.gk[0];

  for (const [secs, p] of [[TOTAL, 0], [300, 0.5], [60, 0.9]]) {
    g.secs = secs;
    assert.ok(Math.abs(totKept({}, lu, g, gk1) - p) < 1e-9, `${secs}s left → ${p}p in goal`);
  }

  // 4:00 left, a field player takes over in goal.
  g.secs = 240;
  const gk2 = lu.periods[0].find((id) => id !== gk1);
  assert.ok(LC.applyKeeperSwap(lu, 0, gk2, g.secs / TOTAL));

  assert.ok(Math.abs(totKept({}, lu, g, gk1) - 0.6) < 1e-9, "outgoing keeper frozen at 6 minutes");
  assert.equal(totKept({}, lu, g, gk2), 0, "incoming keeper starts at zero, not at their credit");

  g.secs = 120;
  assert.ok(Math.abs(totKept({}, lu, g, gk1) - 0.6) < 1e-9, "still frozen — they are out of goal");
  assert.ok(Math.abs(totKept({}, lu, g, gk2) - 0.2) < 1e-9, "incoming accrues from the swap");

  g.secs = 0;
  assert.ok(Math.abs(totKept({}, lu, g, gk1) + totKept({}, lu, g, gk2) - 1) < 1e-9,
    "the two of them account for exactly one period in goal");
});

test("the D/F strip does not count a position the child has not stood in", () => {
  const lu = newGame();
  const g = { started: true, onBreak: false, period: 1, secs: TOTAL };
  // Someone the plan has at D in P1 and F later (or the reverse) — the ratio
  // must not move until the later period is played.
  const subject = lu.periods[0].find((id) => {
    const a = LC.posInPeriod(lu, 0, id), b = LC.posInPeriod(lu, 1, id);
    return a && b && a !== b && a !== "GK" && b !== "GK";
  });
  assert.ok(subject, "the builder rotated somebody between P1 and P2");

  const p1pos = LC.posInPeriod(lu, 0, subject);
  g.secs = 0;                                    // P1 played out
  const after1 = dfStrip(posTotals(lu, {}, g));
  const mine = dfStrip(posTotals(lu, {}, g)[subject]);
  assert.deepEqual(mine, p1pos === "D" ? { d: 100, f: 0 } : { d: 0, f: 100 },
    "one period played, one position — the strip is all of it");
  assert.ok(after1, "strip computed");

  // The old number already blended P2, P3 and P4 in.
  const before = dfStrip(oldPos(lu, {})[subject]);
  assert.notDeepEqual(before, mine, "the uncapped ratio was already showing the plan");
});

test("a typical game: four periods, subs every period, one keeper swap", () => {
  // A season already in progress — the archive cache the card merges with.
  const cached = { Ana: { GK: 2, D: 5, F: 3 }, Ben: { GK: 1, D: 4, F: 6 } };
  const kept = { Ana: 2, Ben: 1 };
  const lu = newGame(kept, cached);
  const g = { started: true, onBreak: false, period: 1, secs: TOTAL };
  const log = [];

  const snapshot = () => IDS.map((id) => ({
    id, played: played(lu, g, id), kept: totKept(kept, lu, g, id),
    // absent = nothing played and nothing cached, which is what pre-kickoff looks like
    pos: posTotals(lu, cached, g)[id] || { GK: 0, D: 0, F: 0 },
  }));

  // Invariant checked at every beat of the game, not just at the end.
  const check = (where) => {
    const periodsRun = curPi(g) + (1 - remFrac(g));
    for (const s of snapshot()) {
      assert.ok(s.kept <= (kept[s.id] || 0) + periodsRun + 1e-9,
        `${where}: ${s.id} kept ${r1(s.kept)}p with only ${r1(periodsRun)}p of game played`);
      assert.ok(s.kept >= (kept[s.id] || 0) - 1e-9, `${where}: ${s.id} kept went backwards`);
      assert.ok(s.kept <= s.played + (kept[s.id] || 0) + 1e-9,
        `${where}: ${s.id} kept more goal than they played field`);
      const c = cached[s.id] || { GK: 0, D: 0, F: 0 };
      const thisGame = (s.pos.GK + s.pos.D + s.pos.F) - (c.GK + c.D + c.F);
      assert.ok(thisGame <= periodsRun + 1e-9,
        `${where}: ${s.id}'s position ledger holds ${r1(thisGame)}p of a ${r1(periodsRun)}p game`);
      assert.ok(Math.abs(thisGame - s.played) < 1e-9,
        `${where}: ${s.id} position total ${r1(thisGame)} vs played ${r1(s.played)}`);
    }
  };

  check("pre-kickoff");

  for (let p = 1; p <= Q; p++) {
    g.period = p; g.onBreak = false; g.secs = TOTAL;
    const pi = p - 1;
    check(`P${p} kickoff`);

    g.secs = 420;                                        // 3:00 in — a routine sub
    check(`P${p} 3:00`);
    const off = lu.periods[pi].find((id) => id !== lu.gk[pi]);
    LC.applySub(lu, pi, off, bench(lu, pi)[0], g.secs / TOTAL);
    check(`P${p} after sub`);

    if (p === 3) {                                       // the keeper takes a knock
      g.secs = 240;
      LC.applyKeeperSwap(lu, pi, lu.periods[pi].find((id) => id !== lu.gk[pi]), g.secs / TOTAL);
      check("P3 after keeper swap");
    }

    g.secs = 180; check(`P${p} 7:00`);
    g.secs = 0;   check(`P${p} whistle`);
    log.push(`P${p}: ` + IDS.map((id) => `${id} ${r1(played(lu, g, id))}p/${r1(totKept(kept, lu, g, id) - (kept[id] || 0))}gk`).join("  "));

    if (p < Q) { g.onBreak = true; g.secs = 150; check(`break after P${p}`); }
  }

  // Full time: the banked numbers and the season archive rows must agree, or the
  // card and the D1 ledger tell parents two different stories.
  g.period = Q; g.onBreak = false; g.secs = 0;
  const rows = LC.appearanceRows(lu, "gid1", Q);
  const byPlayer = {};
  for (const r of rows) (byPlayer[r.player_id] = byPlayer[r.player_id] || { GK: 0, D: 0, F: 0 })[r.pos] += r.frac;

  for (const id of IDS) {
    const arch = byPlayer[id] || { GK: 0, D: 0, F: 0 };
    assert.ok(Math.abs(played(lu, g, id) - (arch.GK + arch.D + arch.F)) < 2e-3,
      `${id}: card says ${r1(played(lu, g, id))}p, archive says ${r1(arch.GK + arch.D + arch.F)}p`);
    assert.ok(Math.abs((totKept(kept, lu, g, id) - (kept[id] || 0)) - arch.GK) < 2e-3,
      `${id}: goal time disagrees with the archive`);
    const c = cached[id] || { GK: 0, D: 0, F: 0 }, t = posTotals(lu, cached, g)[id];
    for (const pos of ["GK", "D", "F"]) {
      assert.ok(Math.abs((t[pos] - c[pos]) - arch[pos]) < 2e-3, `${id}: ${pos} disagrees with the archive`);
    }
  }

  // Everyone had a turn in goal across four periods, and nobody had two.
  const goalKeepers = IDS.filter((id) => totKept(kept, lu, g, id) - (kept[id] || 0) > 0.05);
  assert.ok(goalKeepers.length >= Q, `only ${goalKeepers.length} children saw goal in ${Q} periods`);
  for (const id of IDS) {
    assert.ok(totKept(kept, lu, g, id) - (kept[id] || 0) <= 1 + 1e-9, `${id} kept more than one period`);
  }

  console.log("    " + log.join("\n    "));
});

test("the capped and uncapped ledgers converge at full time", () => {
  const lu = newGame();
  const g = { started: true, onBreak: false, period: 1, secs: TOTAL };
  for (let p = 1; p <= Q; p++) {
    g.period = p; g.secs = 420;
    LC.applySub(lu, p - 1, lu.periods[p - 1].find((id) => id !== lu.gk[p - 1]), bench(lu, p - 1)[0], 420 / TOTAL);
    g.secs = 0;
  }
  g.period = Q; g.secs = 0;
  // At the final whistle there is no future left, so the cap costs nothing — the
  // two definitions must agree or this change moved a season number.
  const capped = posTotals(lu, {}, g), uncapped = oldPos(lu, {});
  for (const id of IDS) {
    for (const pos of ["GK", "D", "F"]) {
      assert.ok(Math.abs((capped[id]?.[pos] || 0) - (uncapped[id]?.[pos] || 0)) < 1e-9,
        `${id} ${pos}: ${capped[id]?.[pos]} vs ${uncapped[id]?.[pos]}`);
    }
    assert.ok(Math.abs(totKept({}, lu, g, id) - oldKept({}, lu, id)) < 1e-9, `${id} goal time at full time`);
  }
});
