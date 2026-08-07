"use strict";
/* The save file: its default shape, the forward-migration of docs written by
   older versions, and the read. No DOM, no rendering — loaded by the app as a
   plain script (window.SaveState) and by node --test.

   Writes stay in app.js: save() also has to stamp the sync meta and schedule a
   push, which is glue, not shape. */
var SaveState = (function () {

  function defaults() {
    return {
      team: "",
      roster: ["Bearett", "Neel", "Jeffrey", "Oliver", "Reyansh", "Zendrix", "Connor", "George"]
        .map(function (n, i) { return { id: "seed" + i, name: n, present: true }; }),
      periods: 4, onfield: 6, minsper: 10,
      format: "u8",
      season: "Fall 2026",      // the ledger-reset boundary, stamped on every archive row
      posTotals: {},            // season D/F/GK periods from the archive — cached for offline
      practice: [], practiceRun: { startedAt: 0, idx: 0, marks: [] }, lineup: null,
      played: {},  // career periods played, by player id — drives "rotate this responsibility"
      kept: {},    // career periods in goal, by player id
      game: { us: 0, them: 0, period: 1, secs: 600, running: false, onBreak: false, playerStats: {} }
    };
  }

  // Docs written by older versions of the app (or another device mid-upgrade).
  function fixup(s) {
    if (!s.played) s.played = {};
    if (!s.kept) s.kept = {};
    if (!s.format) s.format = "u8";
    if (s.venue !== "away") s.venue = "home";   // manual for now — nothing auto-fills it
    if (!s.season) s.season = "Fall 2026";
    if (!s.posTotals) s.posTotals = {};
    if (!s.practiceRun) s.practiceRun = { startedAt: 0, idx: 0, marks: [] };
    if (s.game && !s.game.goals) s.game.goals = [];
    if (s.lineup) {
      if (s.lineup.keeper == null) s.lineup.keeper = true;   // every pre-format lineup was U8
      LineupCore.ensureApp(s.lineup);
      // Periods this doc has already started get whole-period interval runs.
      // g.period counts the live period too — a break's period hasn't advanced yet.
      var g = s.game || {};
      LineupCore.ensureIv(s.lineup, g.started ? Math.min(g.period, s.lineup.periods.length) : 0);
    }
  }

  // Older saves banked the plan straight into the career totals. Move the live game back
  // out into its own ledger so it can be corrected before it's committed.
  function migrate(s) {
    if (!s.lineup || s.lineup.actual) return;
    s.lineup.actual = {}; s.lineup.gkActual = {};
    (s.lineup.periods || []).forEach(function (f) {
      f.forEach(function (id) {
        s.lineup.actual[id] = (s.lineup.actual[id] || 0) + 1; s.played[id] = (s.played[id] || 0) - 1;
      });
    });
    (s.lineup.gk || []).forEach(function (id) {
      if (id) { s.lineup.gkActual[id] = (s.lineup.gkActual[id] || 0) + 1; s.kept[id] = (s.kept[id] || 0) - 1; }
    });
  }

  // A doc without a roster is not a doc — a half-written or foreign key falls
  // back to a fresh season rather than booting into a broken sheet.
  function load(key) {
    try {
      var s = JSON.parse(localStorage.getItem(key));
      if (s && s.roster) { fixup(s); migrate(s); return s; }
    } catch (e) {}
    return defaults();
  }

  return { defaults: defaults, fixup: fixup, migrate: migrate, load: load };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SaveState;
