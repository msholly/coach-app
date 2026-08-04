# Coach's Sideline — audit against the U8 coaching guide

**Spec:** `Fall 2026 - Guide for Coaching U8.md` (AYSO Region 630)
**Audited:** `public/index.html` (1052 lines), `src/worker.js`, `schema.sql`
**Date:** 2026-08-03
**Method:** full read of both files, simulation of the rotation algorithm across
Periods 2–6 × On-field 3–7 × present 6–14, line-by-line verification of every citation.
First-pass findings were then adversarially reviewed and revised; see
[Corrections to the first pass](#corrections-to-the-first-pass).

---

## Verdict

The rotation math is sound — the builder never produces an AYSO-illegal lineup in any
configuration. The problems are elsewhere, and they rank in this order:

1. **The app gives confidently wrong information** once the roster changes after a lineup
   is built. This is worse than the missing content, because a coach can compensate for a
   rule they have to remember and cannot compensate for a sheet that lies.
2. **Two guide rules have no implementation at all** — goalkeeper rotation and
   "rotate this responsibility" (bench fairness across games).
3. **Roughly half the guide has no counterpart in the app** — equipment, referees,
   in-play rules, parent conduct, game-day coach conduct.

---

## Severity 1 — the app displays wrong information

### 1.1 Roster changes after a lineup is built silently corrupt it

None of the three roster mutation handlers touch `state.lineup`:

| Action | Line | Consequence |
|---|---|---|
| Delete a player | [index.html:851](../public/index.html#L851) | Dead id stays in `lineup.periods`; Game Day renders a chip reading `?` (`nm()` returns `"?"`, [:827](../public/index.html#L827)); the sheet's footer still claims 6 on field |
| Toggle a player **OUT** | [index.html:852](../public/index.html#L852) | The absent child stays in the on-field list all game. Note the asymmetry: `benchNow` *does* filter on `present` ([:842](../public/index.html#L842)), so they appear on the field **and** are missing from the bench |
| Add a player | [index.html:881](../public/index.html#L881) | Not in `lu.playerOrder`, so `renderLineup` ([:673](../public/index.html#L673)) emits no row. A late arrival is invisible to the "Everyone Plays" check |

The middle row is the common case — a kid goes home at halftime, the coach taps OUT, and
the app keeps assigning them to the field.

### 1.2 The "short on quarters" flag is a false-positive generator

[index.html:685](../public/index.html#L685):

```js
var under = Q===4 ? count<3 : (count*2<Q);   // AYSO: everyone plays >=3 of 4 quarters before anyone gets a 4th
```

The AYSO rule is **comparative** (nobody plays 4 until everybody has 3). This checks an
**absolute** floor. Exhaustive simulation over Q∈{2..6} × N∈{3..7} × L∈{N..14}:

```
real AYSO violations produced by builder:        0
configs where flag fires but nothing is wrong: 142
configs where flag misses a real violation:      0
```

Because the builder keeps all counts within 1 of each other, `max === Q` mathematically
implies `min >= Q-1`. **The flag can never fire on an actual violation.** What it fires on:

```
present=9  periods=4 → counts [3,3,3,3,3,3,2,2,2]  →  3 of 9 painted red
present=10 periods=4 → counts [3,3,3,3,2,2,2,2,2,2] → 6 of 10 painted red
present=12 periods=4 → counts [2,2,2,2,2,2,2,2,2,2,2,2] → 12 of 12 painted red
```

With 9+ present, 24 player-quarters cannot give everyone 3. Nothing is wrong, yet the app
tells the coach ([:693](../public/index.html#L693)) **"▲ short on quarters — swap someone
in"** — advice that is impossible to act on, since swapping anyone in shorts someone else.

It also under-warns: at Q=2 the formula reduces to `count < 1`, so nothing is ever flagged
even when playing time is genuinely lopsided.

### 1.3 A failed build leaves the previous lineup live

[index.html:655](../public/index.html#L655) early-returns after a toast, leaving the stale
`state.lineup` rendered and in use on Game Day. Mark three kids absent, tap Build, miss the
toast — you are now looking at last week's rotation.

### 1.4 Printed rule text is hardcoded to a configuration the user can leave

The controls offer Periods 2–6, On field 3–7, Min/period 4–20 with no validation or
"non-standard format" warning ([:388-396](../public/index.html#L388-L396)). Meanwhile
[:491](../public/index.html#L491) asserts *"at least 3 of 4 quarters"* unconditionally — and
because `.foot-note` sits outside `.panel`, the print rule at
[:317-320](../public/index.html#L317-L320) does **not** hide it. Set Periods to 6 and the
sheet you carry to the field still claims "3 of 4."

Related: `renderLineup` prints game length from the build-time snapshot `lu.minsper`
([:672](../public/index.html#L672)) while the clock uses live `state.minsper` — the sheet and
the clock can disagree.

---

## Severity 2 — guide rules with no implementation

### 2.1 Goalkeeper: max 1 quarter per player — explicitly punted

[index.html:399](../public/index.html#L399) says *"track GK picks yourself — not tracked
here."* The deeper issue is that `state.lineup` has **no GK dimension at all**, so the
printed sheet has nowhere to even record it by hand. This is a schema change, not a text
change — budget accordingly.

### 2.2 "Rotate this responsibility" — no cross-game memory

Guide line 44: *"one player may sit out 2 quarters per game. **Rotate this
responsibility**."*

`buildLineup` always starts at `cursor=0` in roster order
([:654-658](../public/index.html#L654-L658)), and `state` holds no cumulative quarter counts
([:606-613](../public/index.html#L606-L613)). With 9 present, the same last three players in
roster order are shorted **every build, every game**, deterministically. The only escape is
`↻ Reshuffle`, which is `Math.random()` with no tracking.

This is the guide's one explicit fairness-over-time requirement.

### 2.3 No halftime, and no mid-half substitution break

Guide line 37 specifies two 20-min halves, a **2–3 min** sub break mid-half, and a **5 min**
halftime (10 on hot days). `nextPeriod` ([:902-907](../public/index.html#L902-L907)) treats
all four breaks identically and models no break duration at all.

Evidence this was started and abandoned: `var half=Q/2` at
[:674](../public/index.html#L674) — the string `half` appears **exactly once** in the entire
file, its own declaration.

### 2.4 No mid-period safety substitution

Guide line 46 allows safety/injury subs at any time, with re-entry in the same quarter. There
is no mid-period sub mechanism — and the control a coach would instinctively reach for
(IN/OUT) triggers §1.1.

### 2.5 The blowout lever exists but is never connected

Guide line 74 names *"reducing the dominant team's players on the field"* as a remedy.
[index.html:392](../public/index.html#L392) **is** an `On field` select with values 3–7. The
trigger (score differential) and the remedy are two tabs apart with nothing linking them.

---

## Severity 3 — drill library gaps

### 3.1 No goalkeeper drill, no throw-in drill

The guide's longest rules block is the goalkeeper (lines 50–53) and it directly instructs
coaches to *"coach them on the proper technique"* for throw-ins (line 55, with three
specific points). The library has neither. Every U8 player must keep for a quarter; the app
never prepares them.

### 3.2 The suggested plan ends with a drill an 8-player team cannot run

`templatePractice` ([:890](../public/index.html#L890)) closes with 14 minutes of **6v6
Scrimmage** — which needs 12–14 children. The seeded roster is 8, and the guide's stated team
size is 8. No small-sided (3v3/4v4) alternative exists in the library.

### 3.3 "Everyone a ball" holds for 3 of 9 drills, and one prescribes a Line

The `players` field, verbatim — against the guide's "avoid **Lines**, Lectures, Laps":

| Drill | `players:` | Every kid on a ball? |
|---|---|---|
| Everybody's It | "Whole team, everyone a ball" | ✅ |
| Cone Slalom | "Everyone a ball" | ✅ |
| Red Light, Green Light | "Everyone a ball" | ✅ |
| Sharks & Minnows | "2–3 sharks, rest minnows" | ❌ sharks have none |
| Passing Gates | "Pairs, one ball each pair" | ❌ |
| Pass & Move Triangle | "Groups of 3" | ❌ |
| **Shooting Gallery** | **"Line of 3–4 per goal"** | ❌ |
| 1v1 to Goals | "Two small goals, take turns" | ❌ |
| 6v6 Scrimmage | "6 vs 6, with goalkeepers" | ❌ |

Shooting Gallery's own text concedes it: *"Set up 2–3 goals so nobody waits long."* The
Practice tab's lead ([:417](../public/index.html#L417)) repeats the overclaim: *"everyone
with a ball, minimal standing in line."*

The 60-minute total is correct (8+8+10+10+10+14).

---

## Severity 4 — guide content with no counterpart anywhere

Reference material, no app behavior attached:

- **Equipment & safety** — shin guards under socks, no jewelry/watches (*removed*, not taped
  over), cleats, ball size 3. This is a **pre-game checklist action**, not prose.
- **Referees** — 5 center refs Fall / 4 Spring per team; 8U training required for all coaches
  and team refs; **no ref = no goalkeeper for that match**, which invalidates the app's 6v6-
  with-keeper model for that game.
- **In-play rules** — no GK punts, no re-pickup after placing the ball down, hands only in
  the box, throw-in technique, corner 5 yards, goal kick opponents back to halfway.
- **Coaching on Game Day** (guide lines 87–91) — stay on the sideline not behind the goals,
  don't run onto the field, teaching over criticism.
- **Parent-facing** — pre-season meeting, behavior guidelines link, cheer-don't-coach, pick a
  sideline spot, stay 1 yard back.
- **Game start** — start on time, warm up beforehand. No schedule or start-time field; the
  Warmup-tagged drills live only in Practice and can't be attached to Game Day.
- **Heat safety** — appears twice in the guide (hot-day halftime extension; both teams on one
  side for shade). No heat/hydration handling.
- **Kickoff convention** — visitor first half, home second.

---

## Severity 5 — bugs and dead code

| # | Location | Issue |
|---|---|---|
| 1 | [:986-992](../public/index.html#L986-L992) | `adoptServer` replaces `state` wholesale but never calls `startTicker()`, and unlike `boot()` ([:1044](../public/index.html#L1044)) does not force `running=false`. A synced device shows a **Pause button over a frozen clock** |
| 2 | [:803-810](../public/index.html#L803-L810) | `tick()` is a naive `setInterval` with no wall-clock anchor. Phone in a pocket → background throttling → the period runs long. Also never calls `save()`, so a mid-period reload rewinds the clock |
| 3 | [:904](../public/index.html#L904) | `Period +` past the final period silently wraps to Period 1 with the score preserved. No confirmation, no game-over state |
| 4 | [:883-887](../public/index.html#L883-L887) | Changing Min/period doesn't reach `state.game.secs` — Game Day keeps the old time until Reset or Period +. Line 885 is an empty `if` with a comment for a body |
| 5 | [:717](../public/index.html#L717) | `fmtClock` hardcodes the hour to `0` — a drill starting at minute 65 renders `0:65`. Latent (template tops out at 46) but the tab invites editing |
| 6 | [:644](../public/index.html#L644) | The IN/OUT toggle lacks `no-print`, so printed sheets carry stray "IN"/"OUT" text. The `×` delete button is correctly marked |
| 7 | [:118-119](../public/index.html#L118-L119) | Invalid CSS — a selector list ends in `,` followed by `@media`, so **both** the `data-theme` override and the media rule are dropped (they're one malformed rule, not two). Cosmetic only: the tab still gets `--accent-deep` from [:114-117](../public/index.html#L114-L117). The only malformed `@media` of the 11 in the file |
| 8 | [:505-506](../public/index.html#L505-L506) | `uid` / `nid()` dead — `nid` appears once, its own definition. `addPlayer` uses a different id scheme |
| 9 | [:748](../public/index.html#L748) | `url(#stripe)` references a nonexistent def — but the same rect carries `opacity="0"`, so it is a strict no-op |
| 10 | [:674](../public/index.html#L674) | `var half=Q/2` — declared, never read (see §2.3) |

---

## Recommended fix order

1. **Rebuild or invalidate the lineup on any roster mutation** (§1.1). Three one-line
   changes; removes the worst failure mode. Simplest correct version: call `buildLineup()`
   if a lineup exists, else `state.lineup=null; renderLineup()`.
2. **Fix or delete the `under` flag** (§1.2). Correct comparative form:
   `var under = maxCount >= Q && count < Q-1;` — which, given the builder, means deleting the
   red highlight entirely and replacing it with a plain "N× of Q" count.
3. **Goalkeeper column in `state.lineup`** (§2.1) — the only remaining rule the app knows it
   is ignoring. Needs a schema change plus a printed column.
4. **Bench-fairness memory across games** (§2.2) — cumulative quarter counts in `state`, seed
   `cursor` from whoever is most owed.
5. **Halftime + sub-break durations** (§2.3) and the score-differential nudge wired to the
   existing `On field` select (§2.5).
6. **A pre-game checklist** for equipment/safety and warm-up — as checkboxes on Game Day, not
   prose. Prose in a tab nobody opens on a Saturday morning does not get a ring off a
   seven-year-old's finger.
7. **A static Rules tab** quoting the guide for the genuinely reference-only material
   (in-play rules, coach/parent conduct, kickoff convention).
8. Severity 5 items as cleanup. Only #1–#3 there have real game-day impact.

**Not recommended:** a feature per guide rule. Items 6 and 7 cover Severity 4 entirely, and
the referee counter (5 Fall / 4 Spring) is the only piece that arguably needs its own state.

---

## Corrections to the first pass

Recorded because the reversals matter more than the confirmations:

| First-pass claim | Corrected |
|---|---|
| "Rotation never violates ≥3-of-4" graded **conforming** | True but **trivially** true — counts always stay within 1, so the rule can't be broken. The interesting finding is that the flag meant to catch violations (§1.2) fires 142 times on non-problems and never once on a real one |
| "Every drill is 'everyone a ball'" | False — 3 of 9. One drill literally prescribes a Line (§3.3) |
| "Score is tracked but the guide says score isn't kept" — ranked #2 | Overstated. The guide says *"it's obvious when one team dominates (e.g., 5-0)"* — you cannot detect 5-0 without counting. A counter is a **prerequisite**, not a violation. The real finding is the unconnected remedy (§2.5) |
| "Only gaps 1 and 2 change sideline behavior" | Self-contradictory — halftime was ranked third and is a timer defect in the core game-day feature. And all of §1 outranks every gap on the original list |
| Broken CSS listed as bug **A** | Cosmetic shade-of-green; belongs in Severity 5 (§5.7) |
| `syncSettings` stale-lineup nit | The mildest instance of the much broader §1.1 |
| Missed entirely | §1.1, §1.3, §2.2, §2.4, §3.1, §3.2, and Severity 5 items 1–6 |

## Open question for the guide's author

Guide lines 40–41 give **Goal Size 12'×6'** and **Field Size 50'×40'**. A 50-foot-long field
is shorter than a regulation six-yard box; this is almost certainly meant as **yards**. The
app copies it verbatim at [:492](../public/index.html#L492). Worth confirming with Region 630
before it gets printed on anything.
