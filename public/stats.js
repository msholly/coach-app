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

  return { detailOf: detailOf, rollupEvents: rollupEvents, withTimeFixes: withTimeFixes };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ArchiveStats;
