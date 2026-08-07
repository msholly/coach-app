# Handoff: Game Day "On the field" panel — option 8b

**Paste this whole file to Claude Code inside the `coach-app` repo.**

---

## Task

Implement design option **8b** ("Keep the story, add the answer") in `msholly/coach-app` (branch `master`),
replacing the current Game Day *On the field* chip rendering. Implement it **as-is** — the spec below is
final; do not redesign, do not substitute your own colours or copy.

## What the bundled file is

`Game Day Harness.dc.html` is a **design reference**, not production code. It is a standalone HTML harness
that renders three variants of the panel against a simulated game. Open it and look at the block with the
badge **8b**. Its markup is React-flavoured template syntax; do not copy it. Recreate the design in the
repo's own idiom: vanilla ES5-ish JS building HTML strings in `public/app.js`, styles in `public/app.css`,
markup skeleton in `public/index.html`, pure logic in `public/lineup-core.js` (which is covered by
`node --test`).

Fidelity: **high**. Exact hex values, sizes and copy are given below and should be matched.

---

## The idea in one paragraph

Today a chip is a position bubble and a name. In 8b each chip also carries (a) a **verdict** — the app does
the "will this kid make the 3-period minimum" arithmetic and states the conclusion in words, and (b) a
**four-segment track**, one segment per period, where the fill sits *where the minutes actually happened*
inside the period. A player who left and came back shows a real break in the dark fill; a player who came on
partway shows the gap before it. Three textures per segment — dark = played, flat grey = elapsed while they
sat, diagonal stripes = hasn't happened yet. Texture, not hue, because green already means D, cone/orange is
the alarm, and a luminance-only ramp dies in afternoon sun.

---

## Scope

In scope: the `.field-mini` "On the field" panel on the Game Day tab — chips, position rails, the
per-period track, the verdict, the "just on" badge, and the bench list moving inside the panel.

Out of scope: scoreboard, clock, sub/keeper picker cards, season log, lineup sheet. The tap-to-select
sub interaction (`tapChip`, `data-act="chip"`, `data-where`, `data-id`, `.jchip.sel`) must keep working
exactly as it does now.

Note: the harness commentary mentions removing per-row goal/shot buttons. Those never shipped in this repo
— there is nothing to remove.

---

## 1. Data model: a per-period interval ledger (new)

8b needs to know *when inside a period* each player was on. The repo cannot answer that today:

- `lu.actual[id]` / `lu.app[q]` store **fractions only** — how much, not when.
- `lu.actual` is also **plan-inclusive**: `tally()` credits a whole period for every period on the sheet,
  including periods not yet played. It is the fairness ledger, not an elapsed-time ledger. Do not read it
  for this UI.
- The `sub` rows in `logEvent` do carry period + secs, but the outbox is **deleted as it flushes**
  (`flushOutbox` splices `ob.events`), so it is not a durable source.

So add a display-only ledger next to the existing ones. Keep all mutation in `lineup-core.js`.

```
lu.iv[q] = { <playerId>: [[on, off], ...] }    // on/off = fraction of period q, 0..1
                                               // off === null  ⇒ interval still open
```

Rules:

| Event | Effect on `lu.iv` |
|---|---|
| Period `q` starts (kickoff, `nextPeriod`) | for each id in `lu.periods[q]`, push `[0, null]` |
| `applySub(lu, pi, outId, inId, frac)` | at `t = 1 - frac`: close `outId`'s open interval to `t`, push `[t, null]` for `inId` |
| `applyKeeperSwap` | no change — nobody leaves the field |
| `applyPosSwap` | no change |
| Period `q` ends | close every open interval at `1` |
| Rebuild (`buildLineup(_, true)`) | truncate `lu.iv` to `keep` periods, same as `lu.periods`/`lu.app` |
| Older doc with no `lu.iv` | `ensureIv(lu)` synthesises `[[0,1]]` per player per played period, mirroring `ensureApp` — call it from `fixup()` |

Invariant to test (`node --test`, alongside the existing lineup-core tests): for every played period,
`Σ interval lengths` for a player equals that player's credited `frac` for the period, and the sum across
players equals `N × 1`. Add a case for leave-and-return (two intervals, one player) and for an
injury sub at 6:00 of a 10-minute period.

`lu.iv` is **display-only**. Fairness, archive rows and the season ledger stay on `lu.actual` /
`lu.gkActual` / `lu.app` untouched.

## 2. Derived values (per player, per render)

```
Q        = lu.Q                                   // periods, 4 in U8
MIN      = 3                                      // league minimum, 3 of 4 (generalise as Q - 1)
periodT  = 1 - state.game.secs / (lu.minsper*60)  // 0..1 through the current period
el       = (state.game.period - 1) + periodT      // periods elapsed, e.g. 1.4
rem      = Q - el                                 // periods left
P        = Σ over q ≤ current of interval lengths in lu.iv[q]
                                                  // open intervals close at periodT
need     = max(0, MIN - P)
slack    = rem - need
```

Verdict, four ranked states, first match wins:

| State | Test | Label |
|---|---|---|
| met | `P >= MIN - 0.001` | `✓ min met` |
| short | `need > rem + 0.001` | `short 0.4p` (`r1(need - rem)`) |
| on-from-now | `slack < 0.5` | `on from now` |
| spare | otherwise | `+0.6p spare` (`r1(slack)`) |

`r1(v) = Math.round(v*10)/10`. A negative number is never printed: under half a period it becomes
*on from now*, below zero it becomes the *short* pill carrying the deficit's magnitude.

Reading of spare, for the tooltip/help text if you add one: spare = time left − time still needed. It starts
at `+1.0p` for everyone (4 periods − 3 required) and that is its ceiling. Field minutes don't move it; only
bench minutes drain it. It is a **sitting allowance** — `+1.0p` = hasn't sat, `0` = allowance spent.

**"just on" badge:** derive from `lu.iv`, no extra state. Show it when the player's latest interval in the
current period is open, started at `> 0.001` (i.e. a mid-period sub, not a period start), and
`(periodT - start) * lu.minsper * 60 < 120`. It clears after 2:00 of clock or at the period break,
whichever comes first. It means freshness, not fairness: it stops a coach scanning for the next sub from
pulling the kid who just arrived.

## 3. Render cadence

The live segment and the verdict move with the clock. Do **not** rebuild `#onFieldChips` innerHTML every
second — that would drop the tap-selection state. In `updateClock()` (already 1 Hz), write directly to the
live pieces: the live segment's grey width, the played span width of any open interval, and the verdict
text/class when its state changes. Full `renderOnField()` stays on the existing triggers (sub, swap,
period change, build).

## 4. Layout and styling

Structure (`public/index.html`): the bench moves **inside** `.field-mini`, below a divider — `#benchNote`
currently sits above the panel. Chips are grouped GK / D / F, each group a row with a coloured rail on the
left. **Rows are never re-sorted** by played time; group order is fixed GK, D, F, and within a group the
existing period order.

```
.field-mini                 background #0d100b · radius 14 · padding 14 · flex column · gap 9 · color #fff
  h3                        Bahnschrift/Oswald/"Arial Narrow" · uppercase · .06em · 14px · space-between
    right hint              400 11px ui-monospace · #8ef0b1 · "1.4p played · 2.6p left"
  .posrow  (× up to 3)      flex · gap 9 · align-items stretch
    .rail                   width 28 · radius 8 · grid place-items center · Bahnschrift 800
      .rail.gk              background #e8622c (--cone) · #fff · 11px · "GK"
      .rail.d               background #2f7d4f · #fff · 13px · "D"
      .rail.f               background #c78a1e · #14100a · 13px · "F"
    .stack                  flex column · gap 7 · flex 1 1 auto · min-width 0
      .jchip                see below
  .bench-note               border-top 1px rgba(255,255,255,.16) · padding-top 10 · flex column · gap 7
    header                  "Bench" 800 10.5px Bahnschrift · .08em · uppercase · #c8d2c4
    header right            "Notch = 3-period minimum" 400 11.5px · #8ef0b1
    .jchip.bench            same chip, background #c6c3b4, min-height 50 — dimmed, never inverted
```

`.jchip` (field):

```
button · position relative · width 100% · box-sizing border-box · background #f4f2ea · color #14180f
border 0 · radius 10 · padding 7px 11px 7px 9px · font 700 15.5px inherit · display flex
align-items center · gap 9 · text-align left · overflow hidden · min-height 52px
```

Chip children, left to right:

1. **Season D/F strip** — 6px wide, 30px tall, radius 3, overflow hidden, flex column,
   track `rgba(20,24,15,.12)`; top block `#c78a1e` at height = F share, below it `#2f7d4f` at height = D
   share. Shares come from `LineupCore.positionTotals` (season D vs F periods), rounded to whole percents.
2. **Body** — flex column, gap 5, flex 1 1 auto, min-width 0:
   - **Name row** — flex, gap 6, align center. Name: flex 1, ellipsis, nowrap. Then, right-aligned:
     - `just on` — 800 9px system-ui · .07em · uppercase · background `#14180f` · color `#f4f2ea` ·
       radius 4 · padding 3px 5px
     - verdict, one of:
       - met — 800 11px system-ui · `#245f3d`
       - spare — 700 11px ui-monospace · `#3f4a3e`
       - on from now — 800 10px system-ui · .03em · uppercase · background `#14180f` · color `#f4f2ea` ·
         radius 4 · padding 4px 6px
       - short — 800 10px ui-monospace · `#fff` on `#a3420f` · radius 4 · padding 4px 6px
   - **Track** — flex, gap 3, height 12, position relative. One segment per period, `flex 1 1 0`,
     height 12, radius 3, in four mutually exclusive states:

| Segment | Rendering |
|---|---|
| **past, played** | base `rgba(20,24,15,.30)`; one absolutely-positioned `#14180f` span per interval, `left`/`width` = the interval's own fractions |
| **live (current period)** | base `rgba(20,24,15,.06)`; `rgba(20,24,15,.26)` from 0 to `periodT` (elapsed); stripes from `periodT` to the right edge; then the `#14180f` interval spans on top |
| **past, not played** | flat `rgba(20,24,15,.30)` |
| **future** | stripes |

Stripes are `repeating-linear-gradient(135deg, rgba(20,24,15,.32) 0 3px, rgba(20,24,15,.10) 3px 6px)`.

Minimum notch, on every track: absolutely positioned, `top:-4px; bottom:-4px; width:2px;
background:#14180f; left: MIN/Q` → **75%** in U8.

Colour discipline — one meaning per colour, no exceptions: `#14180f` played · `rgba(20,24,15,.30)` sat while
play ran · stripes not yet happened · `#a3420f` unreachable · `#2f7d4f` D · `#c78a1e` F · `#e8622c` GK rail.
Cone/orange appears on a chip **only** for the short pill.

Tokens: `--cone`, `--accent-deep`, `--surface-2`, `--line`, `--ink` already exist in `app.css`. The harness
also uses `--paper: #f4f2ea`; add it if it isn't there, or inline the hex.

## 5. Format cases

- **Keeperless BU5** (`lu.keeper === false`): no GK rail row; the D/F rails and everything else are unchanged.
- **Non-standard periods**: notch at `MIN/Q`, `MIN = Q - 1`. Guard `Q < 2`.
- **No lineup yet**: keep the existing empty-state hint.
- Touch targets stay ≥ 44px; the chip is 52px (bench 50px).
- Respect `prefers-reduced-motion` — nothing in 8b animates, keep it that way.

## 6. Acceptance — reproduce the harness's simulated game

8 players, 6 on the field, 4 × 10-min periods, minimum 3 of 4. 24 period-slots against 8 × 3 = 24 needed:
zero aggregate slack, every kid sits exactly one period. Sit plan: Oliver & Zendrix sit P1, Connor & George
P2, Bearett & Neel P3, Jeffrey & Reyansh P4. At 4:00 into P2 (`el = 1.4`):

- Jeffrey knocked a knee at 6:00 of P1 and came off; Zendrix came on early → Zendrix's P1 segment is
  `[[0.6, 1]]`, a gap then dark fill. Jeffrey's P1 is `[[0, 0.6]]`.
- Reyansh sat out 3:00–5:00 of P1 with a nosebleed and went back on, Oliver covering → Reyansh's P1 is
  `[[0, 0.3], [0.5, 1]]`, a real break in the dark; Oliver's P1 is `[[0.3, 0.5]]`.
- A minute ago Connor went back on for a tired Neel → Connor's P2 is `[[0.3, 0.4…]]` and open; Connor
  wears **just on**; Neel is on the bench with P2 = `[1, 0.3, 0, 0]`.
- Oliver and Zendrix read **on from now**; nobody reads **short** in a working rotation.
- Every column of the ledger sums to 6 × elapsed. Assert this in a test.

The one realistic way **short** fires: a player who arrives at the P2 break and is still not on when P2
kicks off — 3 periods became unreachable at that moment, and the pill must fire then, not at full time.
The harness has this as its "Late arrival" state; use it as your second fixture.

## 7. Files to touch

| File | Change |
|---|---|
| `public/lineup-core.js` | `lu.iv` ledger: open/close/truncate helpers, `ensureIv`, wired into `applySub`; export them |
| `public/app.js` | `renderOnField()` rebuilt around groups + rails + chips; verdict + `P` derivation; `updateClock()` live-updates widths and verdict; `fixup()` calls `ensureIv`; period start/end open and close intervals |
| `public/app.css` | `.field-mini`, `.posrow`, `.rail`, `.jchip` (rewritten), `.jchip .track` + segment states, `.verdict` with four modifiers, `.badge-juston`, `.bench-note` |
| `public/index.html` | move `#benchNote` inside `.field-mini`; group container for the chips |
| tests | interval-ledger invariants + the two fixtures above |

## 8. Ground rules

- Vanilla JS, no build step, no dependencies, offline-first — same as the rest of the app.
- Keep the existing comment voice in these files (short, reasons-not-restatements).
- Fairness maths stays in `lineup-core.js` behind `node --test`; DOM stays in `app.js`.
- Don't touch the archive/outbox schema or the sync path.

## Reference files in this bundle

- `Game Day Harness.dc.html` — open in a browser, scroll to the **8b** badge. `support.js` sits beside it
  so it renders offline. 8a and 8c are the rejected alternatives, kept for context only.
