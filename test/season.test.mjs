import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Season-scale simulations: many full games, typical AYSO progressions.
   Everything here drives LineupCore exactly the way app.js does (same
   mirrors as lineup.test.mjs / played.test.mjs) and follows the app's own
   #1 ranked sub recommendation, then asserts what the engine promises:
     - sub recommendations are well-formed at every moment of every game
     - most-owed players get the extra periods, game after game
     - keeper caps and rotation hold across a season
     - D/F: nobody specializes completely — the floor is ~15-20% even when
       the coach honours a kid's position preference most periods.
       (50/50 is NOT the target; the floor is.) */

const src = readFileSync(new URL("../public/lineup-core.js", import.meta.url), "utf8");
const LC = new Function(src + "\nreturn LineupCore;")();

const Q = 4, EPS = 1e-6;

// mulberry32 — seeded, so every run simulates the same season.
function rng(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (a, rand) => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const ROSTER = ["Ana", "Ben", "Cal", "Dev", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jax"];
const freshCareer = () => ({ played: {}, kept: {}, posTotals: {} });

/* ---------- mirrors of the app.js glue around LineupCore ---------- */

// buildLineup: present sorted most-owed first (stable), build, tally.
function buildGame(career, present, o) {
  const lu = { periods: [], gk: [], actual: {}, gkActual: {}, app: [], Q, N: o.N, keeper: o.keeper };
  const order = present.slice().sort((a, b) => (career.played[a] || 0) - (career.played[b] || 0));
  LC.buildPeriods(lu, order, { keep: 0, Q, N: o.N, keeper: o.keeper, kept: career.kept, posTotals: career.posTotals });
  LC.tally(lu, 0, 1);
  lu.playerOrder = order;
  return lu;
}

// commitGame + the archive accumulating this game's position rows.
function commit(career, lu, gid) {
  for (const id of Object.keys(lu.actual)) career.played[id] = (career.played[id] || 0) + lu.actual[id];
  for (const id of Object.keys(lu.gkActual)) career.kept[id] = (career.kept[id] || 0) + lu.gkActual[id];
  for (const r of LC.appearanceRows(lu, gid, Q)) {
    const t = (career.posTotals[r.player_id] = career.posTotals[r.player_id] || { GK: 0, D: 0, F: 0 });
    t[r.pos] += r.frac;
  }
}

// renderOnField's ranked lists: longest-on goes off (keeper excluded),
// least-played comes on, paired by rank, top three shown. Ties break by
// season-owed (totPlayed — career + this game's projection), then name:
// the old alphabetical tie-break made the same kids the #1 rec every game
// and drifted their season (bug-118).
function recs(lu, career, present, live, rem) {
  const v = (id) => LC.playedThrough(lu, live, id, live, rem);
  const tot = (id) => (career.played[id] || 0) + (lu.actual[id] || 0);   // mirrors totPlayed()
  const gk = lu.gk[live], onNow = lu.periods[live];
  const off = onNow.filter((id) => id !== gk).map((id) => ({ id, v: v(id) }))
    .sort((a, b) => b.v - a.v || tot(b.id) - tot(a.id) || a.id.localeCompare(b.id));
  const on = present.filter((id) => onNow.indexOf(id) < 0).map((id) => ({ id, v: v(id) }))
    .sort((a, b) => a.v - b.v || tot(a.id) - tot(b.id) || a.id.localeCompare(b.id));
  const n = Math.min(off.length, on.length, 3);
  return { off, on, pairs: off.slice(0, n).map((c, i) => [c, on[i]]) };
}

// Every glance at the board must satisfy these, at any clock state.
let recPoints = 0;
function checkRecs(lu, career, present, live, rem) {
  const { off, on, pairs } = recs(lu, career, present, live, rem);
  const gk = lu.gk[live], onNow = lu.periods[live];
  const tot = (id) => (career.played[id] || 0) + (lu.actual[id] || 0);
  for (const c of off) {
    assert.ok(onNow.includes(c.id), `off candidate ${c.id} must be on the field`);
    assert.notEqual(c.id, gk, "the keeper is never recommended off");
    assert.ok(Math.abs(c.v - LC.playedThrough(lu, live, c.id, live, rem)) < EPS);
  }
  for (let i = 1; i < off.length; i++) {
    assert.ok(off[i - 1].v >= off[i].v - EPS, "off list: longest on first");
    if (Math.abs(off[i - 1].v - off[i].v) < EPS)
      assert.ok(tot(off[i - 1].id) >= tot(off[i].id) - EPS, "off ties: most season time first");
  }
  for (const c of on) assert.ok(present.includes(c.id) && !onNow.includes(c.id), `on candidate ${c.id} must be a present bench player`);
  for (let i = 1; i < on.length; i++) {
    assert.ok(on[i - 1].v <= on[i].v + EPS, "on list: least played first");
    if (Math.abs(on[i - 1].v - on[i].v) < EPS)
      assert.ok(tot(on[i - 1].id) <= tot(on[i].id) + EPS, "on ties: most season-owed first");
  }
  assert.equal(pairs.length, Math.min(off.length, on.length, 3));
  if (pairs.length) {
    assert.ok(pairs[0][0].v >= Math.max(...off.map((c) => c.v)) - EPS, "#1 off is the longest on the field");
    assert.ok(pairs[0][1].v <= Math.min(...on.map((c) => c.v)) + EPS, "#1 on is the least played");
  }
  recPoints++;
  return pairs;
}

// The coach honouring a kid's D/F preference at the period briefing:
// swap labels with a teammate already at the wanted position (applyPosSwap).
function prefSwaps(lu, pi, prefs, p, rand) {
  for (const id of Object.keys(prefs)) {
    const want = prefs[id], have = LC.posInPeriod(lu, pi, id);
    if (!have || have === "GK" || have === want || rand() >= p) continue;
    const mate = (lu.app[pi] || []).find((e) => e.pos === want && e.frac > EPS && e.id !== id && !prefs[e.id]);
    if (mate) LC.applyPosSwap(lu, pi, id, mate.id);
  }
}

/* One simulated game, the typical progression: announce the sheet, honour
   preferences at each briefing, glance at the board mid-period, and make the
   app's #1 recommended sub partway through most periods. Optionally a kid
   goes home at half-time (redrawFrom, like the app's mid-game redraw). */
function playGame(career, present, o, rand) {
  const lu = buildGame(career, present, o);
  const planned = {};
  present.forEach((id) => { planned[id] = lu.periods.filter((f) => f.includes(id)).length; });
  const here = present.slice();
  for (let pi = 0; pi < Q; pi++) {
    if (o.prefs) prefSwaps(lu, pi, o.prefs, o.prefP ?? 0.75, rand);
    checkRecs(lu, career, here, pi, 0.25 + 0.5 * rand());   // a mid-clock glance
    if (rand() < (o.subP ?? 0.75)) {
      const rem = 0.2 + 0.6 * rand();                       // sub somewhere mid-period
      const pairs = checkRecs(lu, career, here, pi, rem);
      if (pairs.length) assert.ok(LC.applySub(lu, pi, pairs[0][0].id, pairs[0][1].id, rem));
    }
    checkRecs(lu, career, here, pi, 0);                     // the whistle
    if (o.departAfterHalf && pi === 1 && here.length - 1 >= o.N) {
      here.splice(here.indexOf(o.departAfterHalf), 1);
      const order = here.slice().sort((a, b) =>
        ((career.played[a] || 0) + (lu.actual[a] || 0)) - ((career.played[b] || 0) + (lu.actual[b] || 0)));
      LC.redrawFrom(lu, 1, order, { N: o.N, keeper: o.keeper, kept: career.kept, posTotals: career.posTotals });
    }
  }
  commit(career, lu, o.gid || "g");
  return { lu, planned, here };
}

/* ---------- season-level checks shared by the tests ---------- */

const spread = (vals) => Math.max(...vals) - Math.min(...vals);
const minorityShare = (t) => {
  const d = (t && t.D) || 0, f = (t && t.F) || 0;
  return d + f > EPS ? Math.min(d, f) / (d + f) : 0;
};
function assertGameInvariants(lu, o, planned) {
  // conservation over everyone credited — including a kid who went home early
  const total = Object.values(lu.actual).reduce((n, v) => n + v, 0);
  assert.ok(Math.abs(total - Q * o.N) < EPS, `field-periods conserve (${total} vs ${Q * o.N})`);
  // the builder hands the extra periods to the most-owed: BUILD-time planned
  // counts never increase along the most-owed-first order (subs mutate
  // lu.periods, so the plan is judged from the snapshot, not the final sheets)
  const counts = lu.playerOrder.map((id) => planned[id]);
  for (let i = 1; i < counts.length; i++)
    assert.ok(counts[i - 1] >= counts[i], `most-owed first gets the extra period (${counts})`);
  for (const id of Object.keys(lu.gkActual))
    assert.ok(lu.gkActual[id] <= 1 + EPS, `${id} capped at one period in goal per game`);
  if (o.keeper) {
    const gks = lu.gk.filter(Boolean);
    assert.equal(new Set(gks).size, gks.length, "no one keeps twice in a game");
    gks.forEach((gk, q) => assert.ok(lu.periods[q].includes(gk), "keeper is on the field"));
  } else {
    assert.ok(lu.gk.every((g) => g === null), "keeperless: nobody in goal");
  }
}

/* ---------- the seasons ---------- */

test("20-game season, 8 players at 6v6, occasional subs: every game fair on its own", () => {
  const IDS = ROSTER.slice(0, 8), career = freshCareer(), rand = rng(11);
  // AYSO-typical usage: subs happen at the inter-period stops (the plan), plus
  // an occasional mid-period sub (a tired or knocked kid) — subP 0.25.
  const o = { N: 6, keeper: true, subP: 0.25 };
  for (let g = 0; g < 20; g++) {
    const { lu, planned } = playGame(career, IDS, { ...o, gid: "a" + g }, rand);
    assertGameInvariants(lu, o, planned);
    const played = IDS.map((id) => lu.actual[id] || 0);
    // 24 slots / 8 players: everyone is planned exactly 3 of 4 (the guide's
    // target) and even a rec-followed sub never takes anyone below half.
    for (const id of IDS) assert.equal(planned[id], 3);
    assert.ok(Math.min(...played) >= 2 - EPS, `everyone plays at least half the game (${played})`);
  }
  // Season keeper rotation: 80 keeps over 8 players — within one of each other.
  assert.ok(spread(IDS.map((id) => career.kept[id])) <= 1 + EPS, "career keeps within one");
  // Exact-division rosters have no spare period for the BUILDER to repay sub
  // drift with (the Roster tab warns about exactly this), but the rec list's
  // season-owed tie-break repays on every tie, so the drift stays around a
  // period per six games instead of compounding (bug-118, and its guard test
  // below).
  const seasonSpread = spread(IDS.map((id) => career.played[id]));
  assert.ok(seasonSpread <= 4, `career spread stays bounded (${seasonSpread.toFixed(2)})`);
  // D/F with no preferences expressed: the rotation lands everyone near even —
  // comfortably above the 15-20% floor.
  for (const id of IDS) {
    const m = minorityShare(career.posTotals[id]);
    assert.ok(m >= 0.3, `${id} rotates through both positions (minority ${m.toFixed(2)})`);
  }
  console.log(`    8p season: career spread ${seasonSpread.toFixed(2)}, ` +
    `minority shares ${IDS.map((id) => minorityShare(career.posTotals[id]).toFixed(2)).join(" ")}`);
});

test("20-game season, 9 players at 6v6: the builder repays sub drift across games", () => {
  const IDS = ROSTER.slice(0, 9), career = freshCareer(), rand = rng(22);
  const o = { N: 6, keeper: true };
  const spreads = [];
  for (let g = 0; g < 20; g++) {
    const { lu, planned } = playGame(career, IDS, { ...o, gid: "b" + g }, rand);
    assertGameInvariants(lu, o, planned);
    spreads.push(spread(IDS.map((id) => career.played[id])));
  }
  // 24 slots / 9 players: there IS a spare period each game, and it goes to
  // whoever is furthest behind — so the career spread cannot walk away even
  // with the #1 recommendation followed most periods.
  assert.ok(Math.max(...spreads) <= 1.75, `career spread repaid every game (max ${Math.max(...spreads).toFixed(2)})`);
  // The keeper pick is greedy over whoever is ON THE FIELD that period, so an
  // odd roster can lag a keep behind the pure rotation — within two, not one.
  assert.ok(spread(IDS.map((id) => career.kept[id])) <= 2 + EPS, "career keeps within two");
  for (const id of IDS)
    assert.ok(minorityShare(career.posTotals[id]) >= 0.3, `${id} rotates through both positions`);
  console.log(`    9p season: career spread per game max ${Math.max(...spreads).toFixed(2)}, ` +
    `end ${spreads[spreads.length - 1].toFixed(2)}`);
});

test("24-game season with preferences: forward-lover stays forward-heavy, floor holds for everyone", () => {
  const IDS = ROSTER.slice(0, 8), career = freshCareer(), rand = rng(33);
  // Fay loves forward, Dev loves defense; the coach honours it at ~3 of 4
  // briefings. Position swaps move no minutes, so sub usage stays occasional.
  const o = { N: 6, keeper: true, prefs: { Fay: "F", Dev: "D" }, prefP: 0.75, subP: 0.25 };
  for (let g = 0; g < 24; g++) {
    const { lu, planned } = playGame(career, IDS, { ...o, gid: "c" + g }, rand);
    assertGameInvariants(lu, o, planned);
  }
  const share = (id, pos) => {
    const t = career.posTotals[id];
    return t[pos] / (t.D + t.F);
  };
  // The preference is visible — these two are NOT at 50/50…
  assert.ok(share("Fay", "F") >= 0.55, `Fay forward-heavy (${share("Fay", "F").toFixed(2)})`);
  assert.ok(share("Dev", "D") >= 0.55, `Dev defense-heavy (${share("Dev", "D").toFixed(2)})`);
  // …but nobody specializes completely: the seeding keeps offering the other
  // position, so the minority share never drops through the 15% floor.
  for (const id of IDS) {
    const m = minorityShare(career.posTotals[id]);
    assert.ok(m >= 0.15, `${id} above the floor (minority ${m.toFixed(2)})`);
  }
  // Teammates absorbing the swaps stay in a healthy band, not shoved to a pole.
  for (const id of IDS.filter((x) => !o.prefs[x]))
    assert.ok(minorityShare(career.posTotals[id]) >= 0.25, `${id} not collateral damage`);
  // Position swaps move no minutes, so the time spread here is only the
  // exact-division sub drift bounded above (24 games vs 20, same rate).
  const seasonSpread = spread(IDS.map((id) => career.played[id]));
  assert.ok(seasonSpread <= 5, `time fairness unaffected by position prefs (${seasonSpread.toFixed(2)})`);
  console.log(`    prefs: spread ${seasonSpread.toFixed(2)}, Fay F ${share("Fay", "F").toFixed(2)} / D ${share("Fay", "D").toFixed(2)}, ` +
    `Dev D ${share("Dev", "D").toFixed(2)} / F ${share("Dev", "F").toFixed(2)}, ` +
    `others minority min ${Math.min(...IDS.filter((x) => !o.prefs[x]).map((id) => minorityShare(career.posTotals[id]))).toFixed(2)}`);
});

test("14-game season, 10-player roster, real attendance: owed players are paid back", () => {
  const career = freshCareer(), rand = rng(44);
  const o = { N: 6, keeper: true };
  const games = [];      // {present, planned} per game, for the payback checks
  let departer = null, departGame = -1;
  for (let g = 0; g < 14; g++) {
    const k = 7 + Math.floor(rand() * 4);                  // 7..10 make it today
    const present = shuffle(ROSTER, rand).slice(0, k);
    const opts = { ...o, gid: "d" + g };
    if (g === 5) { departer = present[0]; departGame = 5; opts.departAfterHalf = departer; }
    const { lu, planned } = playGame(career, present, opts, rand);
    assertGameInvariants(lu, o, planned);
    // nobody who came rides the bench all game
    for (const id of present) assert.ok((lu.actual[id] || 0) >= 1 - EPS, `${id} plays at least a period`);
    if (g === 5) {
      assert.ok(!lu.periods[2].includes(departer) && !lu.periods[3].includes(departer),
        "the kid who went home is off the second-half sheets");
      assert.ok((lu.actual[departer] || 0) <= 2 + EPS, "and credited only what they played");
    }
    games.push({ present, planned });
  }
  // Payback: the first game the half-time departer attends afterwards, the
  // builder hands them a max share of periods.
  const next = games.findIndex((gm, i) => i > departGame && gm.present.includes(departer));
  assert.ok(next > 0, "the departer comes back at some point");
  const counts = Object.values(games[next].planned);
  assert.equal(games[next].planned[departer], Math.max(...counts), "the departer gets the big share next time");
  // Season totals track attendance: per-attended-game averages stay close.
  const avg = ROSTER.map((id) => {
    const n = games.filter((gm) => gm.present.includes(id)).length;
    return career.played[id] / Math.max(1, n);
  });
  assert.ok(spread(avg) <= 1, `per-game averages stay close (${avg.map((v) => v.toFixed(2)).join(" ")})`);
  for (const id of ROSTER)
    assert.ok(minorityShare(career.posTotals[id]) >= 0.15, `${id} above the D/F floor`);
  console.log(`    attendance: per-game avg spread ${spread(avg).toFixed(2)}`);
});

test("10-game BU5 season, 6 players at 4v4 keeperless: no goal, same fairness", () => {
  const IDS = ROSTER.slice(0, 6), career = freshCareer(), rand = rng(55);
  const o = { N: 4, keeper: false };
  for (let g = 0; g < 10; g++) {
    const { lu, planned } = playGame(career, IDS, { ...o, gid: "e" + g }, rand);
    assertGameInvariants(lu, o, planned);
    for (const id of IDS)
      assert.ok(planned[id] >= 2, "everyone planned at least half");
  }
  assert.deepEqual(career.kept, {}, "a keeperless season books zero goal time");
  assert.ok(spread(IDS.map((id) => career.played[id])) <= 1.75, "career spread repaid (16/6 leaves spares)");
  for (const id of IDS)
    assert.ok(minorityShare(career.posTotals[id]) >= 0.3, `${id} rotates D/F with no keeper in the mix`);
});

test("injury: off mid-period, back on later the same period — guide line 46", () => {
  const IDS = ROSTER.slice(0, 8), career = freshCareer(), rand = rng(66);
  const { lu } = ((c) => ({ lu: buildGame(c, IDS, { N: 6, keeper: true }) }))(career);
  // Period 2, 70% left: a fielder goes down. The injured player is whoever the
  // coach must take, not the rec — but the replacement IS the app's #1 on.
  const pi = 1;
  const hurt = lu.periods[pi].find((id) => id !== lu.gk[pi]);
  const { on } = recs(lu, career, IDS, pi, 0.7);
  const replacement = on[0].id;
  assert.ok(LC.applySub(lu, pi, hurt, replacement, 0.7));
  // With the injured player benched and behind, the board now ranks them
  // first (or tied-first) to come back on.
  const after = recs(lu, career, IDS, pi, 0.5);
  const minOn = Math.min(...after.on.map((c) => c.v));
  assert.ok(after.on.some((c) => c.id === hurt && c.v <= minOn + EPS), "the injured kid tops the on list");
  // Feeling better with 20% of the period left: straight back on (re-entry in
  // the same period is allowed), taking the replacement's spot back.
  assert.ok(LC.applySub(lu, pi, replacement, hurt, 0.2));
  checkRecs(lu, career, IDS, pi, 0.1);
  // The clock splits credit exactly: hurt played 0.3 + 0.2, replacement 0.5.
  const rows = LC.appearanceRows(lu, "inj", Q).filter((r) => r.period === pi + 1);
  const fracOf = (id) => rows.filter((r) => r.player_id === id).reduce((n, r) => n + r.frac, 0);
  assert.ok(Math.abs(fracOf(hurt) - 0.5) < 1e-3, `injured credited ${fracOf(hurt)}`);
  assert.ok(Math.abs(fracOf(replacement) - 0.5) < 1e-3, `replacement credited ${fracOf(replacement)}`);
  const total = IDS.reduce((n, id) => n + (lu.actual[id] || 0), 0);
  assert.ok(Math.abs(total - Q * 6) < EPS, "conservation survives the double sub");
});

test("bench edges: no bench means no recommendations; one bench pairs one swap", () => {
  // Exactly six show up: everyone plays everything, the board recommends nothing.
  const six = ROSTER.slice(0, 6), c6 = freshCareer();
  const lu6 = buildGame(c6, six, { N: 6, keeper: true });
  for (let pi = 0; pi < Q; pi++) {
    const { pairs, on } = recs(lu6, c6, six, pi, 0.5);
    assert.equal(pairs.length, 0, "no swaps available — the bench is empty");
    assert.equal(on.length, 0);
  }
  commit(c6, lu6, "six");
  for (const id of six) assert.equal(c6.played[id], Q, "everyone played the whole game");

  // Seven: exactly one pair on the board each period, and over five games the
  // single bench slot rotates so the careers stay within a period.
  const seven = ROSTER.slice(0, 7), c7 = freshCareer(), rand = rng(77);
  for (let g = 0; g < 5; g++) {
    const { lu } = playGame(c7, seven, { N: 6, keeper: true, subP: 0.5, gid: "f" + g }, rand);
    for (let pi = 0; pi < Q; pi++) {
      const { pairs } = recs(lu, c7, seven, pi, 0);
      assert.ok(pairs.length <= 1, "one bench player, at most one pair");
    }
  }
  assert.ok(spread(seven.map((id) => c7.played[id])) <= 1.75, "seven-kid careers stay close");
});

/* The bug-118 scenario, kept as the fix's regression guard: the ranked list
   once broke played-time ties ALPHABETICALLY, so on an exact-division roster
   (8 kids at 6v6 = exactly 3 periods each, no spare period to repay with)
   following the #1 rec most periods shaved the same alphabetically-first
   kids — 12.4 periods of career spread over 20 games. The season-owed
   tie-break makes rec-followed subs repay the season on every tie; what is
   left (~3.7 over 20 games) is the backward-looking primary key itself,
   which only projection-ranking would remove. */
test("bug-118 guard: aggressive rec-following on an exact-division roster stays bounded", () => {
  const IDS = ROSTER.slice(0, 8), career = freshCareer(), rand = rng(11);
  const o = { N: 6, keeper: true, subP: 0.75 };
  for (let g = 0; g < 20; g++) {
    const { lu, planned } = playGame(career, IDS, { ...o, gid: "k" + g }, rand);
    assertGameInvariants(lu, o, planned);   // every per-game promise still holds
  }
  const seasonSpread = spread(IDS.map((id) => career.played[id]));
  assert.ok(seasonSpread <= 5, `owed tie-break caps rec-following drift (${seasonSpread.toFixed(2)}; alphabetical ties measured 12.4)`);
  console.log(`    bug-118 guard: aggressive rec-following drift on 8p roster = ${seasonSpread.toFixed(2)} periods over 20 games`);
});

test("the recommendation board was exercised at scale", () => {
  // Every playGame() above ran checkRecs at 2-3 clock states per period —
  // this is the count of moments the ranked-list invariants were verified.
  assert.ok(recPoints > 800, `rec invariants checked at ${recPoints} decision points`);
  console.log(`    rec invariants verified at ${recPoints} decision points across the simulated seasons`);
});
