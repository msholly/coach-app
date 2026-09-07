# Handoff — product review fixes (Codex second opinion)

> Source: independent Codex review, 2026-08-11. Findings IDs (`§1.1`, `§9.1`, …) refer to that review.
> Baseline: **119/119 tests pass** (`npm test`). Groups are independent and shippable on their own.
> Order below is severity × laziness — earlier groups are more value per line.

## Ground rules (apply to every group)

- OpenWolf project: read `.wolf/OPENWOLF.md`, check `.wolf/cerebrum.md` Do-Not-Repeat before coding,
  log fixed bugs to `.wolf/buglog.json`, append to `.wolf/memory.md`, update `.wolf/anatomy.md` on
  new/renamed files.
- **Never run `git commit`** — stage and print the commit command (user's git-commit-policy).
- **Ponytail applies**: laziest change that closes the gap. No framework, no build step, no new
  runtime dependency, no router. If your fix is longer than the problem, ship the lazy version.
- Verification is not optional: reproduce → fix → re-run the reproduction. `npm test` must stay
  ≥ 119 passing. State the actual count.
- Windows gotcha (bug-125): `Get-Process workerd | Stop-Process -Force` before trusting any local
  server verification — orphaned workerd serves stale bundles.
- Never write `.wolf/*.json` with PowerShell (BOM corrupts) — use Write/Edit tools.
- **Any change to a file in `sw.js`'s `SHELL` list requires a `CACHE` version bump** (`public/sw.js:5-8`,
  cerebrum bug-151). Every group below except Group 1's test-only work touches shell files. Bump once
  per group, not per edit.

---

## Group 1 — Playing-time truth (§1.1 + §2.2 + §2.1) · ~95 lines · **do first**

The app's one promise is honest playing time, and it currently credits *planned* time for games that
end early. Everything else in this doc is cosmetic next to this.

```
Read docs/product-fixes-handoff.md Group 1 and implement it. The bug: when a game ends early
(weather, forfeit, manual full-time before the last period), closeGameRow() in public/app.js archives
appearances through the current period without clipping to elapsed clock time, and the future periods
were already tallied into lu.actual at build time — so commitGame() banks minutes that were never
played into career fairness. Fix the ledger, then fix the labels that call projections "actual".
Write the failing test first. Ponytail: smallest change, no refactor beyond the extraction the test
needs. Do not commit.
```

**1a — clip the ledger at finalization.** `public/app.js`
- Today: `closeGameRow()` ([app.js:2226-2234](../public/app.js#L2226-L2234)) calls
  `queueAppearances(Math.min(g.period, lu.Q))` with no elapsed clipping; `commitGame()`
  ([app.js:261-265](../public/app.js#L261-L265)) then banks `lu.actual`, which was seeded with the
  full plan at build ([app.js:321](../public/app.js#L321),
  [lineup-core.js:22-26](../public/lineup-core.js#L22-L26)).
- Fix: a `finalizeAtElapsed()` step that (1) clips the live period's fractions to actual elapsed
  seconds — `playedThrough()` ([lineup-core.js:349-386](../public/lineup-core.js#L349-L386)) already
  does this math, reuse it, don't rewrite it — and (2) drops unplayed future periods from `lu.actual`
  before *both* the archive write and the career commit.
- Extract it as a plain function so it can be tested without the DOM (this is the seam Group 6 needs
  anyway — take it here, for free).
- **Do not** migrate existing archive rows. Historical incomplete games stay wrong; note it in the
  bug log. A migration is more risk than the wrong numbers on games already played.

**1b — stop calling projections "actual".** `public/app.js`, `public/lineup-core.js`
- `lu.actual` is a plan ledger until full time. Rename the *display* labels: "Plays"/"actual" on the
  lineup card become **scheduled**; reserve "played" for clock-derived values
  ([app.js:435-473](../public/app.js#L435-L473)).
- Lazy version: rename labels only, leave the internal key `lu.actual` alone. Renaming the key
  touches the test suite and buys nothing. `// ponytail:` comment on the mismatch.

**Verify:**
- New test in `test/played.test.mjs` (or a new `test/finalize.test.mjs`): build a 4-period game, run
  into P2 to 4:00 elapsed, finalize → assert archived appearances contain P1 full + P2 fractional and
  **no P3/P4 rows**; then start a new game and assert career `played` gained only the elapsed amount.
  This test must fail before the fix.
- Second test: a normal full-time game produces byte-identical numbers to today (no regression).
- `npm test` green, report the count.

---

## Group 2 — Storage failure is silent (§5.1) · ~45 lines · zero risk

Every critical save is wrapped in a swallowing try/catch, so a quota-exceeded or private-mode browser
loses a whole game with no signal.

```
Read docs/product-fixes-handoff.md Group 2 and implement it. public/app.js:28-32 and
public/outbox.js:16-18 silently swallow localStorage write failures — the coach's data can vanish
with zero indication. Surface the failure, request persistent storage opportunistically, and add a
one-tap JSON export. Ponytail: no storage abstraction layer, no IndexedDB migration — a flag, a
banner, and a Blob download. Do not commit. Bump sw.js CACHE.
```

- **Surface write failures.** `save()` ([app.js:28-32](../public/app.js#L28-L32)) and
  `Outbox` ([outbox.js:16-18](../public/outbox.js#L16-L18)): on catch, set a sticky flag and render a
  persistent banner — "Not saving on this device. Export your data now." Do not silently continue.
- **Ask for persistence.** One opportunistic `navigator.storage.persist()` call at boot, feature-
  detected. It is allowed to be denied; treat denial as "no change", not an error.
- **Export.** A "Back up now" button that serializes `state` to a JSON Blob download. No import path
  in this group — export is the loss-prevention half and is 10 lines; import is a merge problem.
- **Offline-ready status.** Show "offline-ready" only once the service worker reports a populated
  cache, not on page load. The current implication that it works offline before the first successful
  cache is false ([sw.js:10-15](../public/sw.js#L10-L15)).

**Verify:** in DevTools, deny storage / fill quota → banner appears and export still works. Run the
export, reload from a cleared profile, confirm the JSON contains roster + archive. `npm test` green.

---

## Group 3 — First run is unusable (§9.1) · ~90 lines · highest product value

Eight fake kid names ship as the default roster, and there is no rename. A new coach must add 8 and
delete 8 with a confirm each. This is where they go back to paper.

```
Read docs/product-fixes-handoff.md Group 3 and implement it. public/state.js:13 seeds eight
real-looking player names and public/index.html:50-67 offers add/delete but no rename — a fresh
volunteer coach cannot get their real roster in without 16 operations. Replace with an empty-roster
first-run flow: team name, paste-or-type names one per line, Region 630 defaults stated (not
re-asked), Build. Existing users with a non-empty roster must never see it. Ponytail: this is a
conditional render in the existing shell, NOT a wizard framework or a router. Do not commit.
Bump sw.js CACHE.
```

- **Empty default roster.** `public/state.js:13-14` → `roster: []`. Move the seed names to a
  dev-only fixture if the tests need them (check `test/state.test.mjs` first — it may assert on them).
- **Paste import.** A textarea, one name per line, split on newlines. That is the whole feature.
- **Inline rename.** `public/app.js:1963-1969` — the roster row's name becomes editable in place.
  Deletion already confirms; rename needs no confirm.
- **First-run panel.** Shown only when `roster.length === 0`: team name → paste names → a single line
  stating the locked defaults ("Region 630 U8: 6v6, keeper, 4×10") → Build. Also state, in one line
  each: "Works offline after this page loads once" and "Share this link only with your assistant
  coach — it grants full edit access."
- **Fix the false copy** at `public/index.html:28-30` ("Your team is built in").

**Verify:** clear localStorage → first-run panel appears → paste 8 names → Build produces a valid
lineup, ≤ 60 seconds of interaction. Reload with an existing roster → panel never appears. Rename a
player → historical views still resolve the name. `npm test` green (update `test/state.test.mjs` if
it asserts seed names — that's an intentional change, not a regression).

---

## Group 4 — Season lifecycle & data hygiene (§7.1) · ~100 lines

Deleting a player erases their name from history; editing the season string silently keeps the old
ledgers; there is no coach-level delete.

```
Read docs/product-fixes-handoff.md Group 4 and implement it. Three separate holes in
public/app.js: (1) removing a player at :1963-1969 makes historical views render "?" via nameOf()
at :1931; (2) editing the season text at :1931 changes a string without resetting fairness ledgers,
while the real rollover action at :2235-2249 does it correctly; (3) there is no in-app delete or
data-retention statement, while player notes at :1505-1513 actively invite medical data into a
synced document. Ponytail: archive flag + a name snapshot + make the season field read-only, not a
history subsystem. Do not commit. Bump sw.js CACHE.
```

- **Archive, don't delete.** Roster removal sets `active: false` instead of splicing. Rendering
  filters on `active`; historical name lookup finds the row regardless. One field, no registry.
- **Season string is read-only.** Remove the free-text edit; the only way to change seasons is the
  existing `startNewSeason()` action ([app.js:2235-2249](../public/app.js#L2235-L2249)) that resets
  the ledgers correctly.
- **Delete this team from this device.** One button, confirm, clears the local namespace. It does not
  need to delete server-side — say so in the confirm text.
- **Notes guidance.** Change the notes placeholder to name the boundary: "Coaching notes only — no
  medical, behavior, or contact details." One string change
  ([app.js:1505-1513](../public/app.js#L1505-L1513)).
- **README data statement**: what's stored, where, who can reach it, delete/export at season end.
  Five bullets, not a policy document.

**Verify:** new test — remove a player, then render a historical game → their name still shows.
Season text is not editable in the UI; `startNewSeason` still resets. `npm test` green.

---

## Group 5 — Delete dead weight (§12.1 + §2.1 + §4.1) · ~40 lines · pure subtraction

```
Read docs/product-fixes-handoff.md Group 5 and implement it. This group only deletes. ROW_STATS at
public/app.js:1032 is a permanently-false flag keeping a dead render path alive. Individual scoring
leaders and player rank (app.js:2562-2581, :1400-1422) push comparison at an age level whose own
guide de-emphasizes scores. The schedule API endpoint (src/worker.js:572-609) has no UI reaching it.
Delete each unless you find a live caller — search before deleting, and report anything you kept and
why. Ponytail: deletion needs no replacement. Do not commit. Bump sw.js CACHE.
```

- **`ROW_STATS`** — delete the flag and the dead branch ([app.js:1032](../public/app.js#L1032),
  [:1101-1106](../public/app.js#L1101-L1106)). Confirmed dead: `grep -n ROW_STATS` shows only the
  definition and its own branch.
- **Individual leaders / player rank / assists / SOG** — hide behind an off-by-default "record match
  events" setting, or delete. Keep the private score input: the ±4 blowout nudge
  ([app.js:692-700](../public/app.js#L692-L700)) is guide-backed and worth keeping. De-emphasize the
  score *buttons* (they are currently the most prominent game-day action) without removing them.
- **`state.game.playerStats`** duplicates the archive rollup and can diverge across reload/sync
  ([app.js:1984-2003](../public/app.js#L1984-L2003) vs [stats.js:13-28](../public/stats.js#L13-L28)).
  Pick the archive rollup as the single source; delete the duplicate.
- **Schedule endpoint** — no UI reaches it, it is single-tenant (one global ICS for all teams), and it
  serves kids' game locations. Delete it, or note explicitly why it stays. This also closes the infra
  audit's F2 rather than expanding it.

**Verify:** `npm test` green (`test/schedule.test.mjs` goes away with the endpoint if you delete it —
that's intentional, say so). Game Day renders identically minus the removed surfaces.

---

## Group 6 — Test the journeys, not the invariants (§10.1) · ~200 lines

The pure-math suite is strong. The holes are all at the `app.js` lifecycle level — where the coach
actually lives.

```
Read docs/product-fixes-handoff.md Group 6 and implement it. The 119 existing tests cover
lineup/played/credit/season math well but never drive the app.js game-day lifecycle. Add the four
journey tests listed there, extracting only the seams each test needs. Ponytail: no test framework,
no jsdom dependency, no page-object layer — node --test with the smallest extraction that makes the
behavior callable. If a test needs 200 lines of harness, the seam is wrong, not the test.
```

Add, in priority order:
1. **Early finish** — Group 1's test. If Group 1 shipped, this exists; verify it does.
2. **Full lifecycle** — Build → Start → P1 expiry → break → P2 → full time → next game. Assert the
   game row and the appearance cutoff. This is the one test that would have caught §1.1.
3. **Roster history** — remove/rename a player, render a historical game, assert the name resolves.
4. **Outbox same-key in-flight update** — the known edge at
   [outbox.js:54-61](../public/outbox.js#L54-L61): a `frac` updated for a key whose POST is in flight
   is dropped. Test it, then decide whether to fix (a version counter) or document.
5. **Conflict choice** — "use theirs" vs "keep mine" at
   [app.js:2407-2418](../public/app.js#L2407-L2418) produces the expected local state / force call.

**Don't bother with:** more `stats.js` malformed-detail cases, more defaults-restating tests, or the
"exercised at scale" coverage sentinel. Those are upkeep without defect-catching value.

---

## Group 7 — Game Day is overstuffed (§6.1) · ~120 lines · needs a design decision first

Ranked high by the review but it is a redesign, not a fix — it changes the screen the user built and
uses. **Get the user's call before implementing.**

The proposal: default Game Day shows clock, next-period lineup, field, bench, and one explicit
"Substitute" button. Everything else — D/F strip, fair-play verdicts, format switching, season
metrics, correction tools — moves behind "Details". The two-tap chip gesture
([app.js:1075-1080](../public/app.js#L1075-L1080)) becomes a labeled mode with a visible
"Sub X → Y" confirmation.

Also in scope, and worth doing **regardless** of whether the redesign happens (these are ~15 lines
total and are straight accessibility bugs):
- Score ± buttons have no team-specific accessible names ([index.html:188-196](../public/index.html#L188-L196)).
- Sub-4.5:1 contrast pairs: amber `#c78a1e` and orange `#e8622c` on white; `#9aa79a`/`#7d8a7c` labels
  on dark ([app.css:441-470](../public/app.css#L441-L470), [:517-547](../public/app.css#L517-L547)).
- 8.5–11.5px metadata text is unreadable at arm's length in sun.
- Long-press to open a player card is undiscoverable and keyboard/screen-reader inaccessible
  ([app.js:1891-1912](../public/app.js#L1891-L1912)) — needs a visible affordance.

**Recommendation: ship the a11y fixes now as part of Group 5, defer the redesign** until the user has
used the current screen for a real game and can say which panels they never look at. Redesigning on a
reviewer's judgment rather than the coach's own use is how the screen got dense in the first place.

---

## Group 8 — Drill content (§8.1) · ~180 content lines · not code

12 drills won't carry a 10-week season, and two of them (Sharks & Minnows elimination, Shooting
Gallery lines) conflict with the guide's "no Lines, Lectures, Laps" rule
([drills.js:24-33](../public/drills.js#L24-L33), [:66-83](../public/drills.js#L66-L83)).

This is a **content task, not an engineering task** — it needs the guide open and someone who has
coached 7-year-olds, not a refactor. Do it in a separate session with the guide loaded. Scope:
- Fix the two problem drills (multiple grids / rapid restarts, explicitly written into the setup).
- Add ~10 parameterized variants covering the progression gaps: receiving/first touch, shielding,
  change of direction, 1v1 defending, passing under pressure, build-out.
- Each card: setup, cones/balls count, group size, a 90-second coach prompt, one easier + one harder
  variation.
- Restructure the 60-minute template around Play-Practice-Play (open with a game, not a warm-up)
  ([app.js:1979-1982](../public/app.js#L1979-L1982)).

---

## Deferred — do not "fix" these

- **§11.1 splitting `app.js`** (L, ~350 moved lines). 2,752 lines is uncomfortable but the file is
  not the thing hurting the user, and every split multiplies the shell-cache versioning hazard that
  has already bitten once (bug-151). Revisit when a change is genuinely hard to make, not on line
  count. If it does happen: the seams are `game-day.js`, `sync.js`, `player-card.js`, `practice.js`,
  one commit each, one cache bump each.
- **Two-device merge.** The 409 conflict path is whole-document winner-takes-all and that is the right
  amount of machinery for two people. The lazy improvement is *wording*: "Assistant is view-only
  unless taking over" + a named handoff button. Not a merge engine.
- **Voice game log, Firebase, Azure** (`docs/voice-game-log-plan.md`, `firebase-research.md`,
  `azure-research.md`). All three conflict with local-first/zero-budget. Voice additionally needs
  network, which breaks the one promise the app makes.
- **Archive migration for already-played incomplete games.** See Group 1 — wrong historical numbers
  are cheaper than a migration against production data.
- **Historical accuracy of the prior audits.** The Codex review notes the infra audit's S1/C1/C2/C3/C5
  are already fixed in the working tree and the coaching-guide audit predates keeper rotation. Both
  docs are historical records — add a one-line "superseded" header, don't rewrite them.

## Definition of done (whole batch)

- Groups 1–6 landed and verified as specified; 7 pending user decision; 8 in its own session.
- `npm test` ≥ 119 passing, count reported, any pre-existing failure named as pre-existing.
- One `sw.js` `CACHE` bump per shipped group.
- `.wolf/buglog.json` (§1.1 at minimum — it's a real data-corruption bug), `.wolf/cerebrum.md`,
  `.wolf/anatomy.md`, `.wolf/memory.md` updated.
- Staged commits, one per group, commit commands printed — not committed by the agent.
