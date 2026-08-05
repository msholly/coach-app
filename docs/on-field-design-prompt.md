# "On the field" — design iteration prompt

Narrower companion to [game-day-design-prompt.md](game-day-design-prompt.md): that one covers
the whole Game Day screen, this one iterates **only on the `.field-mini` panel** — the player
rows, the bench, and the sub line. Paste the prompt below into Claude (claude.ai for an
instant interactive artifact, or a fresh Claude Code session).

The mockup must keep the app's real class names and CSS variables, so porting a winner back
is mostly paste. Nothing in `lineup-core.js`, the worker, or the schema is design-affected.

**Iteration loop:** ask for 2–3 labelled variants → view at 390px wide → reply with what to
keep/kill → repeat. One round trip per decision.

---

## The prompt

```text
Redesign the "On the field" panel of a PWA used by a volunteer U8 soccer coach standing on
a sideline. Build ONE self-contained HTML file (inline CSS + a small inline JS state
toggler, no external assets, no frameworks, no CDN, no images). This is a design harness,
not the app: fake data, no persistence, but every state below reachable from a toggle bar
fixed at the bottom.

WHO USES IT AND WHERE (hard constraints — design for the worst case):
- One-handed phone use at 390px, often with gloves, in direct October sunlight.
- Glances of 1-2 seconds while watching the field. Anything needing a second look failed.
- Touch targets >=44px. No hover-dependent affordances, no drag gestures, no tooltips.
- Auto light/dark via prefers-color-scheme. This panel is DARK IN BOTH THEMES on purpose
  (it reads as the pitch) — but it sits on a page whose surroundings flip. Respect
  prefers-reduced-motion.
- Sunlight kills hue and thin borders. Luminance flips survive; coloured outlines do not.

DESIGN TOKENS (keep these exact custom properties so a winner ports straight back):
  Light: --bg:#f4f2ea --surface:#fbfaf5 --surface-2:#efece1 --ink:#1b241f --muted:#5c665e
         --line:#ddd9cb --accent:#2f7d4f --accent-deep:#245f3d --accent-soft:#e2efe6
         --cone:#e8622c --cone-soft:#fbe4d8 --amber:#c78a1e --paper:#f4f2ea
  Dark:  --bg:#131711 --surface:#1c2119 --surface-2:#232a20 --ink:#eef2e8 --muted:#9aa79a
         --line:#2f382c --accent:#4fae74 --accent-deep:#3d9160 --accent-soft:#1f2c22
         --cone:#ff7a45 --cone-soft:#2e2016 --amber:#e6b455 --paper:#eef2e8
  Panel itself: background #0d100b, radius 14px, padding 14px, white text. Edge-to-edge
  (negative side margins, radius 0) below 720px.
  Type: "Bahnschrift"/"Oswald"/"Arial Narrow" stack, uppercase, for headings, rails and
  big numbers (tabular-nums); system-ui for body; ui-monospace for the small stat numbers.

CLASS NAMES TO PRESERVE (a delegated click handler and several render functions depend on
these; renaming them breaks the app, so treat them as the contract):
  .field-mini .field-mini.break  h3 > #fmTitle + .fm-hint(.armed)
  .onfield > .posrow > .rail(.gk|.d|.f) + .stack
  .jrow > .jchip + .jstat > .statbtn        (1-column layout)
  .jchip .jchip.sel .jchip.bench  .dot-off .dot-on .nm .ndl .pp .pp .half
  .bench-note > .bhrow > .bh + .rec ; .benchchips
  .subline .sph .subpairs > .sp > .rk + .sd.off + .ar + .sd.on ; .why
  .changes > .chg-row(.off|.on|.gk) > .lab + b + .was
  .nk-btn ; .nk-pick > .kchip(.sel|.capped) > .lb ; .nk-note
Every tappable element carries data-act ("chip", "goal", "sog", "nk-toggle", "nk-pick")
and chips carry data-where="field"|"bench" and data-id. Keep them.

WHAT THE PANEL CONTAINS TODAY (one row per on-field player, grouped by position):
  [GK|D|F rail]  [ chip: (dot) Name  ·  D ---|--- F  ·  0.4p 4m ]  [ ⚽0 ] [ 🥅0 ]
- rail: a coloured vertical bar spanning a position group. GK=cone, D=green, F=amber.
- chip: cream (--paper) on the near-black panel, 50px min-height, the whole thing is ONE
  tap target. The goal/shot buttons must stay OUTSIDE it — a chip cannot nest buttons.
- dot: cone dot on a field chip = "this player is next off". Green dot on a bench chip =
  "next on". Same shape, opposite meanings.
- needle (.ndl): a read-only SEASON indicator of that player's defence/forward balance.
  Centre = even split. It is the ONLY season number on the chip.
- .pp: periods and minutes played THIS GAME, both elapsed clock time. A half-filled pip
  appears when a substitution split one of that player's periods.
- .jstat: goal and shot-on-goal loggers with running counts.
Below the rows: a bench block (heading + a recommendation line + bench chips), then a sub
line that shows either "Next subs — in priority order" (ranked off→on pairs) during play,
or a "Changes for period N" briefing during a break, plus a "Next keeper" button that
expands into a picker.

INTERACTION: tap one player, then tap a second. field+field = swap positions; field+bench
= substitution; either one being the keeper = keeper swap. Tapping the same chip twice
deselects. There is no tutorial — the panel has to teach this itself.

STATES THE TOGGLE BAR MUST REACH:
  a) Pre-kickoff — every chip reads 0p 0m, every needle identical (see OPEN QUESTIONS)
  b) Mid-period running — fractional values like 0.4p 4m
  c) A chip selected — currently inverts to solid --cone with a dark inset ring
  d) Just after a sub — one player at 0p 0m, one carrying the split pip
  e) Break — panel titled "Starting period 3", amber inset ring, sub line becomes the
     Coming off / Going on / In goal briefing
  f) Next-keeper picker open, including one chip in the "capped" (greyed) state
  g) Keeperless format (BU5) — no GK rail, no keeper row, no Next keeper button
  h) Bench empty — "Everyone's on the field this period."
  i) Light <-> dark toggle
Fake data: George GK, Jeffrey/Bearett/Neel D, Connor/Reyansh F; bench Oliver + Zendrix;
period 2 of 4, 10-minute periods.

OPEN QUESTIONS — propose answers, do not just restyle:
1. "0p 0m" is now redundant. Minutes are exactly periods x period-length, so the chip
   prints one fact twice. Drop one? Which? Or make them earn their separate keep?
2. The pre-kickoff state (a) is six identical rows of zeros and identical needles — a full
   panel of ink carrying almost no information. What should this screen say before a ball
   is kicked, when the coach is actually deciding the starting eleven?
3. The needle looks like a slider but is read-only, and it is the only season-scoped thing
   on a chip where everything else is this-game. Does it belong here at all, or does it
   need to look categorically different from the live numbers?
4. Density: 6 rows + rails + bench + sub line, under a sticky clock band, on a 390px
   screen. What has to be visible without scrolling while the clock runs, and what can
   collapse? Is the one-row-per-player list even the right form?
5. The two dot colours carry opposite meanings in two places, at 9px. Is colour alone
   doing too much work, especially in sunlight?
6. .statbtn is 38px wide — under the 44px target — and dark-on-dark beside a bright chip.
   Fix the size without letting goal-logging crowd out the sub flow, which is the panel's
   primary job.
7. Two-tap discoverability: today a single hint line does all the teaching. Better ways
   that survive a coach who has used the app twice this season?
8. The rails cost 30px of a 390px screen to say GK/D/F. Worth it, or can position live on
   the chip?

DELIVERABLE: one HTML file with 2-3 visually distinct variants selectable from the toggle
bar. Label them A/B/C with one sentence each on the tradeoff. Every state above must work
in every variant, in both themes. After the file, list in <=12 lines which app.css rules
each variant changes, so porting cost is visible.
```

---

## Constraints a designer will otherwise trip over

These are load-bearing and cost real debugging time when broken:

- `.jchip.bench` needs the `.field-mini` prefix to beat the page-level bench rule. Without
  it the bench chips render black-on-black inside the dark panel.
- Never hide a menu or picker with `opacity:0` alone. It keeps its layout box and silently
  eats taps meant for whatever sits underneath; take it out of flow.
- `[hidden]` is guarded globally with `display:none!important` because author `display`
  rules beat the attribute. Don't remove that guard.
- New `.btn` variants must be written `button.btn.btn-x` — a bare class loses to
  `button.btn`'s base green.
- The `.pp` half pip is computed from the *plan*, not from the displayed value. Under
  elapsed timing every number is fractional mid-period, so pipping on the display would
  mark almost every chip.

## Porting a winner back

1. Copy the variant's changed rules into `public/app.css` — names already match.
2. Element states come from `renderOnField()` in `public/app.js`; the mockup's toggler
   simulates the classes it sets (`.sel` on chips, `.break` on the panel, `.armed` on the
   hint, `hidden` on the keeper block).
3. If a variant changes what a number *means* rather than how it looks, that's
   `lineup-core.js` and needs tests — `playedThrough()` and `test/played.test.mjs`.
4. `npm test` must stay green. Bump `CACHE` in `public/sw.js` or installed PWAs keep the
   stale UI.
