# Game Day UI — design iteration prompt

Paste the prompt below into Claude (claude.ai for an instant interactive artifact, or a
fresh Claude Code session) to iterate on the Game Day screen **as a standalone mockup**,
without touching the live app. When a variant wins, port it back by copying its CSS into
`public/app.css` — the mockup is required to keep the app's real class names and CSS
variables, so porting is mostly paste.

**Iteration loop:** ask for 2–3 labelled variants → view on a phone (or 390px-wide
window) → reply with what to keep/kill → repeat. One round trip per decision.

---

## The prompt

```text
Build a single self-contained HTML file (inline CSS + a small inline JS state toggler,
no external assets) that mocks up the "Game Day" screen of a PWA used by a volunteer
U8 soccer coach standing on a sideline. This is a design iteration harness, not the app:
fake data, no persistence, but every visual state reachable from a toggle bar.

WHO USES IT AND WHERE (hard constraints — design for the worst case):
- One-handed phone use (390px wide), often wearing gloves, in direct October sunlight.
- Glances of 1–2 seconds while watching the field. The clock, score, and "who's on"
  must be readable at arm's length; everything else is secondary.
- Touch targets ≥44px. No hover-dependent affordances. No drag gestures.
- Auto light/dark theme via prefers-color-scheme; must be legible in BOTH, and the
  dark theme is what sunlight users see most. Respect prefers-reduced-motion.

DESIGN SYSTEM (keep these exact CSS custom properties and class names so the winning
design ports straight back into the real stylesheet):
  Light: --bg:#f4f2ea --surface:#fbfaf5 --surface-2:#efece1 --ink:#1b241f
         --muted:#5c665e --line:#ddd9cb --accent:#2f7d4f --accent-deep:#245f3d
         --accent-soft:#e2efe6 --cone:#e8622c --cone-soft:#fbe4d8 --amber:#c78a1e
  Dark:  --bg:#131711 --surface:#1c2119 --surface-2:#232a20 --ink:#eef2e8
         --muted:#9aa79a --line:#2f382c --accent:#4fae74 --accent-deep:#3d9160
         --accent-soft:#1f2c22 --cone:#ff7a45 --cone-soft:#2e2016 --amber:#e6b455
  Type: display font "Bahnschrift/Oswald/Arial Narrow" stack, uppercase, for headings
        and big numbers (tabular-nums); system-ui for body. Radius 12px cards.
  Key class names to preserve: .scoreboard .sb-top .period-pill .clock-big .clock-note
  .ends .score .gd-controls .field-mini .onfield .jchip .jchip.gk .jchip.sel .subline
  .bench-note .benchchips .nudge .logrow .loghead .loglist .card .btn

SCREEN INVENTORY (what Game Day contains today, two columns ≥720px, stacked below):
1. Scoreboard (dark green gradient card, always dark in both themes):
   period pill · play clock (56px, deliberately smaller than it used to be) ·
   "⏸ CLOCK STOPPED — tap Start" alarm line · "ends ≈ 11:05" wall-clock estimate ·
   us/them score with +/− steppers · Start/Pause, Period +, Reset buttons.
2. Blowout nudge (orange banner, appears at goal difference ≥4).
3. "On the field" card (dark green pitch-colored): one chip-button per player, each
   showing position badge (GK/D/F) + first name; a subline listing In goal / Coming
   off / Going on / Next keeper; a bench strip of chip-buttons below.
   Interaction: tap a chip to select (outline ring), tap a second to act —
   field+field = swap positions, field+bench = substitution, GK involved = keeper swap.
4. "Keeper swap" card: select of on-field players ("Neel — 0.4 in goal this game") + button.
5. "Sub now" card: Coming off / Going on selects + Swap button.
6. "Game log" card: rows "8/2  3–1" that expand to an event list
   ("P2 · 3:47  Goal — Comets", subs, keeper swaps, clock stops).

STATES THE TOGGLE BAR MUST REACH (buttons fixed at the bottom of the mockup):
  a) Pre-kickoff (clock 10:00, nothing started)          b) Running (green clock)
  c) Paused mid-period (CLOCK STOPPED alarm, amber, pulsing unless reduced-motion)
  d) Period expired (0:00 + alarm)                       e) Final 30s warning (orange)
  f) Chip selected (ring on one field chip)              g) Blowout nudge visible
  h) BU5 keeperless (no GK badge, no keeper card/rows)   i) Log row expanded
  j) Light ↔ dark theme toggle
Fake data: 6 on field (Bearett GK, Neel D, Jeffrey D, Oliver D, Reyansh F, Zendrix F),
bench Connor + George, score 2–1, period 2 of 4, 10-min periods.

WHAT TO EXPLORE (the open design questions — propose, don't just restyle):
- Glance hierarchy: is clock-above-score right, or should "who's on" outrank score?
- The stopped-clock alarm: loud enough to catch a coach mid-conversation, calm enough
  not to panic during a deliberate halftime pause?
- Chip legibility in sunlight: white-on-green vs higher-contrast alternatives; how big
  can 6 chips + bench get on 390px before wrapping hurts more than size helps?
- The two-tap flow: how to communicate "tap one, then the other" without a tutorial —
  microcopy, ghost hints, or first-selection state change?
- Can Keeper swap / Sub now collapse into the pitch card entirely once tap-to-act
  exists, keeping the selects only as a fallback?

DELIVERABLE: one HTML file, 2–3 visually distinct variants selectable from the toggle
bar (label them A/B/C with one sentence each on the tradeoff), all states above
working in each variant. No frameworks, no CDN, no images. After the file, list in
≤10 lines which app.css rules each variant would change, so porting cost is visible.
```

---

## Porting a winner back

1. Copy the variant's changed rules into `public/app.css` (names already match).
2. Any new element states must come from `renderGame()`/`renderOnField()`/`updateClock()`
   in `public/app.js` — the mockup's toggler simulates classes those functions set:
   `.run` `.warn` `.stopped` on `#clock`, `.sel` on chips, `hidden` on cards.
3. Nothing in `public/lineup-core.js`, the worker, or the schema is design-affected.
4. `npm test` must stay green; sw.js only changes if a new file is added (don't).
