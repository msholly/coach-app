"use strict";
/* The archive outbox: append-only rows with client-generated ids, written to
   localStorage first and flushed opportunistically on the push cadence. Retry
   is free — INSERT OR IGNORE / keyed upserts make every POST idempotent — so
   game day depends on nothing. The outbox is per-team local state, never synced.

   Uses localStorage and fetch directly rather than taking them as arguments;
   node --test stubs the globals. Loaded as a plain script (window.Outbox). */
var Outbox = (function () {
  var flushing = false;

  function load(key) {
    try { var o = JSON.parse(localStorage.getItem(key + ":outbox")); if (o && o.events) return o; } catch (e) {}
    return { games: {}, events: [], appearances: {} };
  }
  function save(key, ob) {
    try { localStorage.setItem(key + ":outbox", JSON.stringify(ob)); } catch (e) {}
  }

  // Returns true if a flush ran to completion, false if one was already in
  // flight or the network gave out — the caller uses that to decide whether
  // anything downstream (season position totals) is worth refreshing.
  async function flush(key, base) {
    if (flushing) return false;
    flushing = true;
    try {
      var post = function (p, body) {
        return fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      };
      // Re-read the outbox after EVERY await, and clear rows by id rather than
      // by position. logEvent() writes to this same localStorage key, so saving
      // a snapshot taken before the request drops whatever the coach tapped
      // while it was in flight — a goal could vanish from the archive.
      var gamesOk = true;
      var gids = Object.keys(load(key).games);
      for (var i = 0; i < gids.length; i++) {
        var row = load(key).games[gids[i]];
        if (!row) continue;
        var rg = await post("/games", row);
        if (rg.ok) { var og = load(key); delete og.games[gids[i]]; save(key, og); } else { gamesOk = false; }
      }
      // Events and appearances are foreign-keyed to the game row, so they wait
      // for it. Both drain in batches, and a failed batch leaves the rest queued.
      while (gamesOk) {
        var batch = load(key).events.slice(0, 200);
        if (!batch.length) break;
        var re = await post("/events", { events: batch });
        if (!re.ok) break;
        var sent = {}; batch.forEach(function (e) { sent[e.id] = 1; });
        var oe = load(key);
        oe.events = oe.events.filter(function (e) { return !sent[e.id]; });
        save(key, oe);
      }
      while (gamesOk) {
        var cur = load(key), keys = Object.keys(cur.appearances).slice(0, 200);
        if (!keys.length) break;
        var ra = await post("/appearances", { rows: keys.map(function (k) { return cur.appearances[k]; }) });
        if (!ra.ok) break;
        var oa = load(key);
        keys.forEach(function (k) { delete oa.appearances[k]; });
        save(key, oa);
      }
      return true;
    } catch (e) { return false; } finally { flushing = false; }
  }

  return { load: load, save: save, flush: flush };
})();
if (typeof module !== "undefined" && module.exports) module.exports = Outbox;
