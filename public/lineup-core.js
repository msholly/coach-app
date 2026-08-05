"use strict";
/* Pure lineup / fairness logic — no DOM, no storage, no globals read.
   Loaded by the app as a plain script (window.LineupCore) and by node --test
   via require. Everything that touches the fairness ledger lives here so it
   can sit behind tests (plan item 4).

   The lineup object (lu):
     periods[q]  array of on-field player ids (order is not meaningful)
     gk[q]       keeper id, or null in a keeperless format
     actual{}    per-game periods actually played (fractional after subs)
     gkActual{}  per-game periods actually kept
     app[q]      per-period position ledger: [{id, pos:"GK"|"D"|"F", frac}]
                 — the state that makes a season position ratio derivable
                 (finding 1.3) and survives rebuild-by-slot (finding 1.1). */
var LineupCore = (function () {

  // ponytail: GK/D/F only, so the split is arithmetic, not a lookup table.
  // One keeper, the rest split with the extra body going to defense.
  // N=3 GK,D,F · N=4 GK,D,D,F · N=6 GK,D,D,D,F,F · keeperless N=4 → D,D,F,F
  function posSplit(N, keeper) { return keeper ? Math.ceil((N - 1) / 2) : Math.ceil(N / 2); }

  function tally(lu, from, sign) {
    for (var q = from; q < lu.periods.length; q++) {
      lu.periods[q].forEach(function (id) { lu.actual[id] = (lu.actual[id] || 0) + sign; });
      var k = lu.gk[q]; if (k) lu.gkActual[k] = (lu.gkActual[k] || 0) + sign;
    }
  }

  function appOf(lu, pi) {
    lu.app = lu.app || [];
    while (lu.app.length <= pi) lu.app.push([]);
    return lu.app[pi];
  }
  // The role a player is playing right now: their latest entry with time left on it.
  function activeEntry(es, id) {
    for (var i = es.length - 1; i >= 0; i--) { if (es[i].id === id && es[i].frac > 1e-9) return es[i]; }
    return null;
  }
  function addFrac(es, id, pos, frac) {
    for (var i = 0; i < es.length; i++) {
      if (es[i].id === id && es[i].pos === pos) { es[i].frac += frac; return; }
    }
    es.push({ id: id, pos: pos, frac: frac });
  }

  // Season position totals: the cached archive numbers (past games, from D1)
  // plus this game's ledger. `cached` must exclude the current game's rows.
  function positionTotals(lu, cached) {
    var out = {};
    Object.keys(cached || {}).forEach(function (id) {
      out[id] = { GK: cached[id].GK || 0, D: cached[id].D || 0, F: cached[id].F || 0 };
    });
    ((lu && lu.app) || []).forEach(function (es) {
      es.forEach(function (e) {
        if (e.frac > 1e-9) {
          var t = out[e.id] = out[e.id] || { GK: 0, D: 0, F: 0 };
          t[e.pos] += e.frac;
        }
      });
    });
    return out;
  }
  function posCount(lu, cached, id, pos) {
    var n = (cached && cached[id] && cached[id][pos]) || 0;
    ((lu && lu.app) || []).forEach(function (es) {
      es.forEach(function (e) { if (e.id === id && e.pos === pos && e.frac > 1e-9) n += e.frac; });
    });
    return n;
  }
  function posInPeriod(lu, q, id) {
    var e = activeEntry(((lu && lu.app) || [])[q] || [], id);
    return e ? e.pos : null;
  }

  // The q loop from buildLineup, plus position seeding (decision 4).
  // order: player ids, most-owed first. opts: {keep, Q, N, keeper, kept, posTotals}.
  // Keeper: fewest career keeps first, at most one period per player per game.
  // D/F: least-experienced-at-that-position first — playing D raises your D
  // count, so the sort rotates everyone through both over the season.
  function buildPeriods(lu, order, o) {
    var L = order.length, cursor = 0;
    lu.app = lu.app || [];
    for (var q = o.keep; q < o.Q; q++) {
      var f = [];
      for (var k = 0; k < o.N; k++) { f.push(order[(cursor + k) % L]); }
      cursor = (cursor + o.N) % L;
      lu.periods.push(f);
      var gk = null;
      if (o.keeper) {
        gk = f.filter(function (id) { return lu.gk.indexOf(id) < 0; })
             .sort(function (a, b) {
               return ((o.kept[a] || 0) + (lu.gkActual[a] || 0)) - ((o.kept[b] || 0) + (lu.gkActual[b] || 0));
             })[0] || f[0];
      }
      lu.gk.push(gk);
      var nD = posSplit(o.N, o.keeper);
      var field = f.filter(function (id) { return id !== gk; })
                   .sort(function (a, b) { return posCount(lu, o.posTotals, a, "D") - posCount(lu, o.posTotals, b, "D"); });
      var es = []; if (gk) es.push({ id: gk, pos: "GK", frac: 1 });
      field.forEach(function (id, i) { es.push({ id: id, pos: i < nD ? "D" : "F", frac: 1 }); });
      lu.app.push(es);
    }
  }

  // Bench→field sub. frac = the fraction of the period the incoming player gets.
  function applySub(lu, pi, outId, inId, frac) {
    if (!lu || !outId || !inId || outId === inId) return false;
    var at = lu.periods[pi].indexOf(outId); if (at < 0) return false;
    // Already on the field: crediting them again would double them up and
    // vanish the outgoing player from the ledger (finding 1.2 follow-on).
    if (lu.periods[pi].indexOf(inId) >= 0) return false;
    lu.periods[pi][at] = inId;
    lu.actual[outId] = (lu.actual[outId] || 0) - frac;
    lu.actual[inId] = (lu.actual[inId] || 0) + frac;
    if (lu.gk[pi] === outId) {
      lu.gk[pi] = inId;
      lu.gkActual[outId] = (lu.gkActual[outId] || 0) - frac;
      lu.gkActual[inId] = (lu.gkActual[inId] || 0) + frac;
    }
    var es = appOf(lu, pi), act = activeEntry(es, outId);
    if (act) { act.frac -= frac; addFrac(es, inId, act.pos, frac); }
    return true;
  }

  // Field↔field keeper swap. Nobody leaves the field, so periods[] and
  // actual[] must not move — only the goal ledger does (finding 1.2).
  // frac = the fraction of the period the new keeper will spend in goal.
  function applyKeeperSwap(lu, pi, newId, frac) {
    var old = lu.gk[pi];
    if (!old || old === newId || lu.periods[pi].indexOf(newId) < 0) return false;
    lu.gk[pi] = newId;
    lu.gkActual[old] = (lu.gkActual[old] || 0) - frac;
    lu.gkActual[newId] = (lu.gkActual[newId] || 0) + frac;
    var es = appOf(lu, pi);
    var oldE = activeEntry(es, old), newE = activeEntry(es, newId);
    var fieldPos = newE ? newE.pos : "D";   // the old keeper takes over the new keeper's spot
    if (oldE) oldE.frac -= frac;
    if (newE) newE.frac -= frac;
    addFrac(es, old, fieldPos, frac);
    addFrac(es, newId, "GK", frac);
    return true;
  }

  // Mid-game switch to a keeperless field (the t5 "no keeper" flow). The
  // keeper comes out of goal keeping the goal time already credited, and one
  // chosen player (offId — may be the keeper) leaves the field for the rest
  // of the period. frac = the fraction of the period still to play.
  // Returns {gk, offPos} for the correction log (offPos is what applyFormatOn
  // needs to reverse it), or null if it can't apply.
  function applyFormatOff(lu, pi, offId, frac) {
    if (!lu || !lu.keeper || !offId) return null;
    if (lu.periods[pi].indexOf(offId) < 0) return null;
    var es = appOf(lu, pi), gk = lu.gk[pi];
    var eOff = activeEntry(es, offId);
    var offPos = eOff ? eOff.pos : "D";
    if (gk) {
      lu.gk[pi] = null;
      lu.gkActual[gk] = (lu.gkActual[gk] || 0) - frac;
      var eGk = activeEntry(es, gk);
      if (eGk) eGk.frac -= frac;
      if (gk !== offId) addFrac(es, gk, "D", frac);   // plays out the rest
    }
    if (offId !== gk) {
      if (eOff) eOff.frac -= frac;
    }
    lu.actual[offId] = (lu.actual[offId] || 0) - frac;
    lu.periods[pi].splice(lu.periods[pi].indexOf(offId), 1);
    lu.keeper = false;
    return { gk: gk || null, offPos: offPos };
  }

  // Reverse of applyFormatOff: onId rejoins the field at onPos and gkId goes
  // back in goal, each credited frac (the fraction of the period remaining).
  function applyFormatOn(lu, pi, onId, onPos, gkId, frac) {
    if (!lu || lu.keeper || !onId) return false;
    if (lu.periods[pi].indexOf(onId) >= 0) return false;
    var es = appOf(lu, pi);
    lu.periods[pi].push(onId);
    lu.actual[onId] = (lu.actual[onId] || 0) + frac;
    addFrac(es, onId, onPos, frac);
    if (gkId && lu.periods[pi].indexOf(gkId) >= 0) {
      lu.gk[pi] = gkId;
      lu.gkActual[gkId] = (lu.gkActual[gkId] || 0) + frac;
      if (gkId !== onId) {
        var eG = activeEntry(es, gkId);   // the field time they were playing out
        if (eG) eG.frac -= frac;
        addFrac(es, gkId, "GK", frac);
      }
      lu.keeper = true;
    }
    return true;
  }

  // Swap two field players' position labels. ponytail: the label swaps
  // wholesale — mid-period D/F fractions aren't split the way GK and sub
  // minutes are; D/F is a judgement aid, not a capped stat.
  function applyPosSwap(lu, pi, a, b) {
    var es = appOf(lu, pi), ea = activeEntry(es, a), eb = activeEntry(es, b);
    if (!ea || !eb || ea.pos === "GK" || eb.pos === "GK" || ea.pos === eb.pos) return false;
    var t = ea.pos; ea.pos = eb.pos; eb.pos = t;
    return true;
  }

  // Older docs (and other devices mid-upgrade) have no position ledger —
  // synthesize one from periods/gk so every consumer can rely on lu.app.
  function ensureApp(lu) {
    if (!lu) return;
    if (lu.app && lu.app.length === lu.periods.length) return;
    lu.app = lu.periods.map(function (f, q) {
      var gk = (lu.gk || [])[q] || null;
      var nD = posSplit(f.length, !!gk);
      var es = []; if (gk) es.push({ id: gk, pos: "GK", frac: 1 });
      f.filter(function (id) { return id !== gk; })
       .forEach(function (id, i) { es.push({ id: id, pos: i < nD ? "D" : "F", frac: 1 }); });
      return es;
    });
  }

  // Periods a player has ACTUALLY PLAYED through period `pi` — as opposed to
  // periods they are down to play, which is what the raw app fracs hold.
  //
  // buildPeriods stamps every entry frac:1 at build time, so a player on the
  // field at kickoff already carries a full period before the ball moves. The
  // one period on the clock is therefore discounted by the share of it that has
  // not run yet. A player already subbed off needs no discount: applySub
  // trimmed their entry to exactly what they played. Periods after `live`
  // contribute nothing — they have not been played at all.
  //
  //   live = index of the period on the clock
  //   rem  = fraction of that period still unplayed (1 before kickoff, 0 at the
  //          whistle, and 0 during a break — the break clock belongs to a
  //          period that is already over)
  //
  // Note the two definitions converge at every period boundary (rem = 0), which
  // is where the guide's "3 of 4 quarters" rule is actually judged.
  function playedThrough(lu, pi, id, live, rem) {
    var app = (lu && lu.app) || [];
    var r = Math.min(1, Math.max(0, rem || 0));
    var last = Math.min(pi, live), n = 0;
    for (var q = 0; q <= last && q < app.length; q++) {
      var cur = 0;
      app[q].forEach(function (e) { if (e.id === id && e.frac > 1e-9) cur += e.frac; });
      if (cur <= 0) continue;
      if (q === live && ((lu.periods[q] || []).indexOf(id) >= 0)) cur -= r;
      if (cur > 0) n += cur;
    }
    return n;
  }

  // Rows for the append-only `appearances` archive, periods 1..upto only —
  // future planned periods must never reach the season ledger.
  function appearanceRows(lu, gid, upto) {
    var rows = [];
    ((lu && lu.app) || []).slice(0, upto).forEach(function (es, q) {
      var m = {};
      es.forEach(function (e) {
        if (e.frac > 1e-9) { var k = e.id + "|" + e.pos; m[k] = (m[k] || 0) + e.frac; }
      });
      Object.keys(m).forEach(function (k) {
        var p = k.split("|");
        rows.push({ game_id: gid, player_id: p[0], period: q + 1, pos: p[1], frac: Math.round(m[k] * 1000) / 1000 });
      });
    });
    return rows;
  }

  return {
    posSplit: posSplit,
    tally: tally,
    buildPeriods: buildPeriods,
    applySub: applySub,
    applyKeeperSwap: applyKeeperSwap,
    applyFormatOff: applyFormatOff,
    applyFormatOn: applyFormatOn,
    applyPosSwap: applyPosSwap,
    ensureApp: ensureApp,
    playedThrough: playedThrough,
    appearanceRows: appearanceRows,
    positionTotals: positionTotals,
    posCount: posCount,
    posInPeriod: posInPeriod
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = LineupCore;
