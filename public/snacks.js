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
  var KEY_CLAIM = "snack:claim", KEY_NAME = "snack:name", KEY_REFNAME = "snack:refname";

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
  // Snack signups read "Sholly family"; a referee is a person's full name. Keep
  // the two remembered names apart so one doesn't prefill the other's field.
  function nameKey(role) { return role === "ref" ? KEY_REFNAME : KEY_NAME; }
  function savedName(role) { try { return localStorage.getItem(nameKey(role)) || ""; } catch (e) { return ""; } }
  function rememberName(role, n) { try { localStorage.setItem(nameKey(role), n); } catch (e) {} }

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtTime(ms) {
    var d = new Date(ms), h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " AM" : " PM");
  }
  function fmtDay(ms) { var d = new Date(ms); return MON3[d.getMonth()] + " " + d.getDate(); }

  var data = null, editing = null;   // editing = { uid, role } whose inline form is open
  function isEditing(uid, role) { return editing && editing.uid === uid && editing.role === role; }

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
    // Season rides in the green kicker; the title stays the team name.
    var kicker = $("#kicker");
    if (kicker) kicker.textContent = "🍊 Snack sign-up" + (d.season ? " · " + d.season : "");
    $("#teamName").textContent = d.team || d.calendar || "Team snacks";
    document.title = (d.team ? d.team + " · " : "") + "Snack sign-up";
    // referees === false means the coach turned referee sign-up off for this
    // team (e.g. BU5, no referees). Hide the slot; the server keeps the rows.
    var refsOn = d.referees !== false;
    var now0 = Date.now();
    var open = d.events.filter(function (e) { return !e.signup && e.startsAt > now0; }).length;
    var refsNeeded = refsOn ? d.events.filter(function (e) { return e.venue === "home" && !e.referee && e.startsAt > now0; }).length : 0;
    $("#sub").textContent = d.events.length + " game" + (d.events.length === 1 ? "" : "s") +
      (refsNeeded ? " · " + refsNeeded + " ref" + (refsNeeded === 1 ? "" : "s") + " needed" : "");
    // Open snack count as a right-column badge; green "All covered" when none left.
    var badge = $("#openBadge");
    if (badge) {
      if (!d.events.length) { badge.hidden = true; }
      else {
        badge.hidden = false;
        badge.textContent = open ? open + " snack" + (open === 1 ? "" : "s") + " open" : "All snacks covered";
        badge.classList.toggle("done", open === 0);
      }
    }
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
        slot(e, past) + (refsOn && e.venue === "home" ? refSlot(e, past) : "") + '</div></li>';
    });
    if (month) html += "</ul>";
    $("#list").innerHTML = html;
    // One inline form is open at a time, so focus whichever just rendered.
    var f = $("form.sn-form input[name=name]");
    if (f) f.focus();
  }

  function slot(e, past) {
    if (isEditing(e.uid, "snack")) return form(e, "snack");
    var s = e.signup;
    if (!s) {
      if (past) return '<div class="sn-slot"><span class="sn-open">No snacks signed up</span></div>';
      return '<div class="sn-slot"><button class="btn ghost sm" type="button" data-act="take" data-role="snack">Sign up for snacks</button></div>';
    }
    var h = '<div class="sn-slot"><span class="sn-who">' + esc(s.name) + (s.mine ? ' <span class="you">you</span>' : "") + "</span>";
    if (s.mine && !past) h += '<button class="btn ghost sm" type="button" data-act="edit" data-role="snack">Change</button><button class="btn ghost sm" type="button" data-act="drop" data-role="snack">Give it back</button>';
    if (s.note) h += '<span class="sn-note">' + esc(s.note) + "</span>";
    h += '<span class="sn-when">signed up ' + esc(fmtDay(s.at)) + "</span></div>";
    return h;
  }

  // Home games need a volunteer referee. Same take/change/give-back as snacks,
  // but the value is one free-form full name and it only shows on home games.
  function refSlot(e, past) {
    if (isEditing(e.uid, "ref")) return form(e, "ref");
    var s = e.referee;
    if (!s) {
      if (past) return '<div class="sn-slot sn-ref"><span class="sn-tag">Referee</span><span class="sn-open">No referee</span></div>';
      return '<div class="sn-slot sn-ref"><span class="sn-tag">Referee</span><button class="btn ghost sm" type="button" data-act="take" data-role="ref">Volunteer to referee</button></div>';
    }
    var h = '<div class="sn-slot sn-ref"><span class="sn-tag">Referee</span><span class="sn-who">' + esc(s.name) + (s.mine ? ' <span class="you">you</span>' : "") + "</span>";
    if (s.mine && !past) h += '<button class="btn ghost sm" type="button" data-act="edit" data-role="ref">Change</button><button class="btn ghost sm" type="button" data-act="drop" data-role="ref">Step down</button>';
    h += '<span class="sn-when">volunteered ' + esc(fmtDay(s.at)) + "</span></div>";
    return h;
  }

  // These are a family's own name and a snack note, prefilled from localStorage —
  // never credentials. Password managers (Bitwarden/1Password/LastPass) still see
  // a text field named "name" and eagerly offer to fill it, popping a vault menu
  // over the parent's form. Turn native autofill off (we prefill ourselves) and
  // tell each extension to skip the field. `autocomplete="off"` on the <form> too.
  var NOFILL = 'autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" ' +
    'data-bwignore data-1p-ignore data-lpignore="true" data-form-type="other"';

  function form(e, role) {
    if (role === "ref") {
      var rs = e.referee, rname = (rs && rs.name) || savedName("ref");
      return '<form class="sn-form sn-ref" data-uid="' + esc(e.uid) + '" data-role="ref" autocomplete="off">' +
        '<input type="text" name="name" maxlength="60" placeholder="Referee\'s full name" value="' + esc(rname) + '" ' + NOFILL + ' required>' +
        '<div class="acts"><button class="btn sm" type="submit">' + (rs ? "Save" : "Volunteer") + '</button>' +
        '<button class="btn ghost sm" type="button" data-act="cancel" data-role="ref">Cancel</button></div></form>';
    }
    var s = e.signup, name = (s && s.name) || savedName("snack"), note = (s && s.note) || "";
    return '<form class="sn-form" data-uid="' + esc(e.uid) + '" data-role="snack" autocomplete="off">' +
      '<input type="text" name="name" maxlength="60" placeholder="Your name (e.g. Sholly family)" value="' + esc(name) + '" ' + NOFILL + ' required>' +
      '<input type="text" name="note" maxlength="140" placeholder="What you\'ll bring (optional)" value="' + esc(note) + '" ' + NOFILL + '>' +
      '<div class="acts"><button class="btn sm" type="submit">' + (s ? "Save" : "Sign up") + '</button>' +
      '<button class="btn ghost sm" type="button" data-act="cancel" data-role="snack">Cancel</button></div></form>';
  }

  function pathFor(uid, role) {
    return "/api/snacks/" + encodeURIComponent(BOARD) + "/" + encodeURIComponent(uid) + (role === "ref" ? "/ref" : "");
  }

  async function take(uid, role, name, note) {
    var body = role === "ref" ? { name: name, claim: claim() } : { name: name, note: note, claim: claim() };
    var r;
    try {
      r = await fetch(pathFor(uid, role), {
        method: "PUT", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) { toast("No signal — try again in a moment"); return; }
    if (r.status === 409) { toast(role === "ref" ? "Someone just volunteered — pick another game" : "Someone just took that game — pick another"); editing = null; await load(); return; }
    if (r.status === 429) { toast("Too many tries — wait a minute"); return; }
    if (!r.ok) { toast("Couldn't save that (" + r.status + ")"); return; }
    rememberName(role, name);
    editing = null;
    toast(role === "ref" ? "You're on to referee — thank you!" : "You're down for snacks — thank you!");
    await load();
  }

  async function drop(uid, role) {
    var msg = role === "ref" ? "Step down from refereeing this game?" : "Give this game back so another family can take it?";
    if (!window.confirm(msg)) return;
    var r;
    try {
      r = await fetch(pathFor(uid, role), {
        method: "DELETE", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ claim: claim() }),
      });
    } catch (e) { toast("No signal — try again in a moment"); return; }
    if (!r.ok && r.status !== 404) { toast("Couldn't do that (" + r.status + ")"); return; }
    toast(role === "ref" ? "Referee slot is open again" : "Game is open again");
    await load();
  }

  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]"); if (!b) return;
    var row = b.closest("[data-uid]"); var uid = row && row.dataset.uid; if (!uid) return;
    var act = b.dataset.act, role = b.dataset.role || "snack";
    if (act === "take" || act === "edit") { editing = { uid: uid, role: role }; render(); }
    else if (act === "cancel") { editing = null; render(); }
    else if (act === "drop") { drop(uid, role); }
  });
  document.addEventListener("submit", function (ev) {
    var f = ev.target.closest("form.sn-form"); if (!f) return;
    ev.preventDefault();
    var role = f.dataset.role || "snack";
    // Query the inputs explicitly: `f.name` is the form's own `name` property,
    // not the control named "name", so reach the fields by selector.
    var nameEl = f.querySelector('input[name=name]'), noteEl = f.querySelector('input[name=note]');
    var name = nameEl ? nameEl.value.trim() : "", note = noteEl ? noteEl.value.trim() : "";
    if (!name) { if (nameEl) nameEl.focus(); return; }
    take(f.dataset.uid, role, name, note);
  });
  // Another parent may have signed up while this tab sat in the background.
  document.addEventListener("visibilitychange", function () { if (!document.hidden && data) load(); });

  load();
})();
