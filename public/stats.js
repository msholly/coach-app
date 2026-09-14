"use strict";
/* Read-side archive math. The event log is append-only — nothing is ever
   deleted — so both of these reconstruct the truth by netting later rows
   against earlier ones. No DOM, no storage, no naming: callers turn the ids
   into names. Loaded as a plain script (window.ArchiveStats) and by node --test. */
var ArchiveStats = (function () {

  function detailOf(ev) { var d = {}; try { d = JSON.parse(ev.detail) || {}; } catch (e) {} return d; }

  // Goals, assists and shots per player. A goal counts detail.d (+1 for the
  // goal, −1 for the row that undoes it) and a shot counts its correction flag
  // as −1 — the same netting the season query does in SQL.
  function rollupEvents(evs) {
    var by = {};
    (evs || []).forEach(function (ev) {
      if (!ev.player_id) return;
      if (ev.kind !== "goal" && ev.kind !== "sog") return;
      var d = detailOf(ev);
      var r = by[ev.player_id] = by[ev.player_id] || { goals: 0, shots: 0, assists: 0 };
      if (ev.kind === "goal") {
        r.goals += (+d.d || 0);
        if (d.assistId) {
          var a = by[d.assistId] = by[d.assistId] || { goals: 0, shots: 0, assists: 0 };
          a.assists += (+d.d || 0);
        }
      } else r.shots += (d.correction ? -1 : 1);
    });
    return by;
  }

  // A goal logged late gets its time corrected by a later goal_time row that
  // names it. postEvents is INSERT OR IGNORE and can never update a flushed
  // row, so the fix is applied here at read time and the correction row itself
  // is dropped from the list. Sorted into match order: period, then clock
  // counting down, then arrival.
  function withTimeFixes(evs) {
    var fix = {};
    (evs || []).forEach(function (ev) {
      if (ev.kind !== "goal_time") return;
      var d = detailOf(ev);
      if (d.ofEvent) fix[d.ofEvent] = { period: d.period, secs: d.secs };
    });
    return (evs || [])
      .filter(function (ev) { return ev.kind !== "goal_time"; })
      .map(function (ev) {
        var f = fix[ev.id];
        return f ? Object.assign({}, ev, { period: f.period, secs: f.secs, moved: true }) : ev;
      })
      .sort(function (a, b) { return (a.period - b.period) || (b.secs - a.secs) || (a.at - b.at); });
  }

  // Per-period primary position per player, from the archived appearance rows.
  // A player who swapped position mid-period (two rows) is shown by the position
  // they spent the most of the period in. Returns { player_id: { qIndex: "GK"|"D"|"F" } }.
  function posByPeriod(appearances, Q) {
    var best = {}, frac = {};
    (appearances || []).forEach(function (a) {
      var qi = (+a.period) - 1; if (qi < 0 || (Q && qi >= Q)) return;
      var id = a.player_id, f = +a.frac || 0;
      (best[id] = best[id] || {}); (frac[id] = frac[id] || {});
      if (frac[id][qi] == null || f > frac[id][qi]) { frac[id][qi] = f; best[id][qi] = a.pos; }
    });
    return best;
  }

  // Reconstruct the interval ledger (iv) for an ARCHIVED game from its appearance
  // rows + sub events — the same shape live Game Day keeps in lu.iv, so the same
  // trackHtml renders it. iv[qIndex] = { player_id: [[on, off], ...] } in fractions
  // of the period. Used to backfill games archived before iv was persisted, and as
  // a fallback whenever games.iv is absent. Going forward the live iv is stored
  // verbatim and this is not needed. The appearance FRAC is authoritative for how
  // much a player was on (it drives every other ledger); sub-event times only place
  // WHERE a partial run sits. A player credited a full period renders as one solid
  // bar even if an event log looks otherwise — the graphic must match the ledger.
  function reconstructIv(game, events, appearances) {
    var Q = +(game && game.periods) || 0;
    var plenSec = ((+(game && game.minsper) || 10)) * 60;
    var iv = [], onByPeriod = [], subsByPeriod = [], q;
    for (q = 0; q < Q; q++) { iv[q] = {}; onByPeriod[q] = {}; subsByPeriod[q] = []; }
    (appearances || []).forEach(function (a) {
      var qi = (+a.period) - 1; if (qi < 0 || qi >= Q) return;
      onByPeriod[qi][a.player_id] = (onByPeriod[qi][a.player_id] || 0) + (+a.frac || 0);
    });
    (events || []).forEach(function (ev) {
      if (ev.kind !== "sub") return;
      var d = detailOf(ev); if (d.correction) return;
      var qi = (+ev.period) - 1; if (qi < 0 || qi >= Q) return;
      var secs = +ev.secs || 0;                       // clock REMAINING → elapsed fraction
      var el = 1 - Math.min(1, Math.max(0, secs / plenSec));
      subsByPeriod[qi].push({ el: el, out: d.out, on: d["in"] });
    });
    subsByPeriod.forEach(function (l) { l.sort(function (a, b) { return a.el - b.el; }); });
    for (q = 0; q < Q; q++) {
      var subs = subsByPeriod[q];
      Object.keys(onByPeriod[q]).forEach(function (id) {
        var T = Math.min(1, onByPeriod[q][id]);
        if (T >= 0.999) { iv[q][id] = [[0, 1]]; return; }   // full period → one solid bar
        var mine = subs.filter(function (s) { return s.out === id || s.on === id; });
        var runs = [];
        if (!mine.length) { runs = [[0, T]]; }              // partial, unplaceable → from kickoff
        else {
          var curOn = (mine[0].out === id);                  // started on if first touch is them leaving
          var segStart = curOn ? 0 : null;
          mine.forEach(function (s) {
            if (s.out === id && curOn) { runs.push([segStart, s.el]); curOn = false; segStart = null; }
            else if (s.on === id && !curOn) { segStart = s.el; curOn = true; }
          });
          if (curOn && segStart != null) runs.push([segStart, 1]);
        }
        runs = runs.filter(function (r) { return r[1] - r[0] > 0.0005; });
        if (runs.length) iv[q][id] = runs;
      });
    }
    return iv;
  }

  return { detailOf: detailOf, rollupEvents: rollupEvents, withTimeFixes: withTimeFixes,
           posByPeriod: posByPeriod, reconstructIv: reconstructIv };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ArchiveStats;
