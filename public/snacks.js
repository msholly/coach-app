"use strict";
/* The parents' snack board. Plain script, no build step, no shared state with
   the coach's app: the only things this page knows are the board id in the
   URL hash and a `claim` token minted on first visit and kept in localStorage.
   The claim is what makes a signup "yours" — it goes up with every write and
   comes back only as a `mine` flag on the board, never as the token itself. */
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var BOARD = (function () {
    var m = (location.hash || "").match(/[#&]b=([A-Za-z0-9_-]{8,64})/);
    return m ? m[1] : null;
  })();
  var KEY_CLAIM = "snack:claim", KEY_NAME = "snack:name";

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function toast(msg) {
    var box = $("#toast"); if (!box) return;
    var el = document.createElement("div");
    el.className = "toast"; el.innerHTML = '<span class="tmsg">' + esc(msg) + "</span>";
    el.addEventListener("click", function () { drop(el); });
    box.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("show"); });
    setTimeout(function () { drop(el); }, 2400);
    function drop(e) { e.classList.remove("show"); setTimeout(function () { if (e.parentNode) e.parentNode.removeChild(e); }, 250); }
  }

  // 16 random bytes, base64url: matches the server's CLAIM_RE and the team-id shape.
  function mint() {
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    var s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function claim() {
    var c = null;
    try { c = localStorage.getItem(KEY_CLAIM); } catch (e) {}
    if (!c || !/^[A-Za-z0-9_-]{16,64}$/.test(c)) {
      c = mint();
      try { localStorage.setItem(KEY_CLAIM, c); } catch (e) { /* private mode: the claim lives for this page load only */ }
    }
    return c;
  }
  function savedName() { try { return localStorage.getItem(KEY_NAME) || ""; } catch (e) { return ""; } }
  function rememberName(n) { try { localStorage.setItem(KEY_NAME, n); } catch (e) {} }

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtTime(ms) {
    var d = new Date(ms), h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " AM" : " PM");
  }
  function fmtDay(ms) { var d = new Date(ms); return MON3[d.getMonth()] + " " + d.getDate(); }

  var data = null, editing = null;   // editing = uid whose inline form is open

  function status(msg) {
    var s = $("#status"); s.hidden = !msg; s.textContent = msg || "";
  }

  async function load() {
    if (!BOARD) { status("This sign-up link isn't complete — ask the coach to send it again."); return; }
    var r;
    try {
      r = await fetch("/api/snacks/" + encodeURIComponent(BOARD) + "?claim=" + encodeURIComponent(claim()), { headers: { accept: "application/json" } });
    } catch (e) { status("Can't reach the server right now. Check your signal and try again."); return; }
    if (r.status === 404) { status("This sign-up link isn't valid any more — ask the coach for a fresh one."); return; }
    if (r.status === 501) { status("The coach hasn't connected the team schedule yet, so there are no games to sign up for."); return; }
    if (!r.ok) { status("Something went wrong loading the schedule (" + r.status + "). Try again in a minute."); return; }
    data = await r.json();
    status("");
    render();
  }

  function render() {
    var d = data; if (!d) return;
    $("#teamName").textContent = d.team || d.calendar || "Team snacks";
    document.title = (d.team ? d.team + " · " : "") + "Snack sign-up";
    var open = d.events.filter(function (e) { return !e.signup && e.startsAt > Date.now(); }).length;
    $("#sub").textContent = (d.season ? d.season + " · " : "") + d.events.length + " games · " + open + " still open";
    $("#foot").hidden = false;

    var now = Date.now(), html = "", month = "";
    if (!d.events.length) html = '<div class="sn-status">No games on the schedule yet.</div>';
    d.events.forEach(function (e) {
      var dt = new Date(e.startsAt), mk = MON[dt.getMonth()] + " " + dt.getFullYear();
      if (mk !== month) { if (month) html += "</ul>"; html += '<div class="sn-month">' + esc(mk) + '</div><ul class="sn-games">'; month = mk; }
      // A game is "past" once it has kicked off; snacks for it are moot.
      var past = e.startsAt < now;
      var title = e.opponent ? (e.venue === "away" ? "@ " : "vs ") + e.opponent : e.summary;
      html += '<li class="sn-game' + (past ? " past" : "") + '" data-uid="' + esc(e.uid) + '">' +
        '<div class="sn-date"><span class="dow">' + DOW[dt.getDay()] + '</span><span class="day">' + dt.getDate() + '</span></div>' +
        '<div class="sn-body"><div class="sn-title">' + esc(title) + '</div>' +
        '<div class="sn-meta">' + esc(fmtTime(e.startsAt)) + (e.location ? " · " + esc(String(e.location).replace(/\s*\n\s*/g, ", ")) : "") + '</div>' +
        slot(e, past) + '</div></li>';
    });
    if (month) html += "</ul>";
    $("#list").innerHTML = html;
    var f = editing && $('.sn-game[data-uid="' + CSS.escape(editing) + '"] input[name=name]');
    if (f) f.focus();
  }

  function slot(e, past) {
    if (editing === e.uid) return form(e);
    var s = e.signup;
    if (!s) {
      if (past) return '<div class="sn-slot"><span class="sn-open">No snacks signed up</span></div>';
      return '<div class="sn-slot"><button class="btn ghost sm" type="button" data-act="take">Sign up for snacks</button></div>';
    }
    var h = '<div class="sn-slot"><span class="sn-who">' + esc(s.name) + (s.mine ? ' <span class="you">you</span>' : "") + "</span>";
    if (s.mine && !past) h += '<button class="btn ghost sm" type="button" data-act="edit">Change</button><button class="btn ghost sm" type="button" data-act="drop">Give it back</button>';
    if (s.note) h += '<span class="sn-note">' + esc(s.note) + "</span>";
    h += '<span class="sn-when">signed up ' + esc(fmtDay(s.at)) + "</span></div>";
    return h;
  }

  function form(e) {
    var s = e.signup, name = (s && s.name) || savedName(), note = (s && s.note) || "";
    return '<form class="sn-form" data-uid="' + esc(e.uid) + '">' +
      '<input type="text" name="name" maxlength="60" placeholder="Your name (e.g. Sholly family)" value="' + esc(name) + '" autocomplete="name" required>' +
      '<input type="text" name="note" maxlength="140" placeholder="What you\'ll bring (optional)" value="' + esc(note) + '">' +
      '<div class="acts"><button class="btn sm" type="submit">' + (s ? "Save" : "Sign up") + '</button>' +
      '<button class="btn ghost sm" type="button" data-act="cancel">Cancel</button></div></form>';
  }

  async function take(uid, name, note) {
    var r;
    try {
      r = await fetch("/api/snacks/" + encodeURIComponent(BOARD) + "/" + encodeURIComponent(uid), {
        method: "PUT", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ name: name, note: note, claim: claim() }),
      });
    } catch (e) { toast("No signal — try again in a moment"); return; }
    if (r.status === 409) { toast("Someone just took that game — pick another"); editing = null; await load(); return; }
    if (r.status === 429) { toast("Too many tries — wait a minute"); return; }
    if (!r.ok) { toast("Couldn't save that (" + r.status + ")"); return; }
    rememberName(name);
    editing = null;
    toast("You're down for snacks — thank you!");
    await load();
  }

  async function drop(uid) {
    if (!window.confirm("Give this game back so another family can take it?")) return;
    var r;
    try {
      r = await fetch("/api/snacks/" + encodeURIComponent(BOARD) + "/" + encodeURIComponent(uid), {
        method: "DELETE", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ claim: claim() }),
      });
    } catch (e) { toast("No signal — try again in a moment"); return; }
    if (!r.ok && r.status !== 404) { toast("Couldn't do that (" + r.status + ")"); return; }
    toast("Game is open again");
    await load();
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]"); if (!b) return;
    var row = b.closest("[data-uid]"); var uid = row && row.dataset.uid; if (!uid) return;
    var act = b.dataset.act;
    if (act === "take" || act === "edit") { editing = uid; render(); }
    else if (act === "cancel") { editing = null; render(); }
    else if (act === "drop") { drop(uid); }
  });
  document.addEventListener("submit", function (ev) {
    var f = ev.target.closest("form.sn-form"); if (!f) return;
    ev.preventDefault();
    var name = f.name.value.trim(), note = f.note.value.trim();
    if (!name) { f.name.focus(); return; }
    take(f.dataset.uid, name, note);
  });
  // Another parent may have signed up while this tab sat in the background.
  document.addEventListener("visibilitychange", function () { if (!document.hidden && data) load(); });

  load();
})();
