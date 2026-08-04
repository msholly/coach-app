# Game Day UI — plan and adversarial review

**Source:** six late-change scenarios from previous seasons, raised by the coach.
**Reviewed:** `public/app.js` (621 lines), `public/index.html`, `public/app.css`,
`public/diagram.js`, `src/worker.js`, `schema.sql`.
**Date:** 2026-08-03
**Method:** first-pass plan written from a full read of the frontend, then handed to an
adversarial reviewer instructed to assume the author was overconfident. The reviewer
transcribed `buildLineup`, `subNow` and `tally` into a scratch harness and executed three
consecutive simulated games on the seeded roster. Every finding below was then re-verified
against the source before being recorded here.

**Revision 2 (2026-08-03):** the four open questions have been answered by the coach. See
[Decisions](#decisions). The material changes: requirement 5 is walked back to a secondary
wall-clock readout with a *smaller* play clock; positions are **GK / D / F** only; and the
game log **does** get real D1 tables. Findings below are left as written — they are the
evidence — with their fix paragraphs updated where a decision changed the answer.

**Revision 3 (2026-08-03):** scope grows — **seasons**, **multiple teams per season**, and a
**keeperless format** for the coach's BU5 side. Fractional periods are confirmed as a
one-decimal display (`D 4.7 · F 1.3`). See
[Two teams, two formats](#two-teams-two-formats--seasons-rosters-and-a-keeperless-mode).

---

## Verdict

**The first-pass plan's keystone claim is false, and it took three other items down with it.**

The plan proposed deriving player positions from the *slot index* of the existing
`lu.periods[q]` array — "zero new state" — and then building everything else on top of that.
The builder does not order that array by position, so the claim fails from the second game
onward. Items 1, 3 and 4 all rested on it.

What survived: extending `diagram.js` rather than adding a drag library, and Pointer Events
over HTML5 `dragstart`.

**What did not survive contact with the coach: the "no SQL tables" call.** The plan and the
reviewer both argued for keeping the log in the JSON doc. The coach overruled it — and
finding 1.3 is the reason they were right. `commitGame`
([`:89-93`](../public/app.js#L89-L93)) folds every finished game down to two scalars per
player, so a season-long position ratio is *arithmetically underivable* from the single-doc
model no matter how the frontend is written. Requirement 3 needs per-game history; per-game
history needs tables. See [The backend](#the-backend--append-only-archive-beside-the-live-doc)
for the design that adds them **without** making game day depend on connectivity.

The revised order front-loads the three items that ship this Saturday and pushes the pitch —
the original keystone — to last, where it becomes a *view* of real state instead of the
mechanism that invents it.

---

## Revised build order

| # | Work | Requirement | Size | Why here |
|---|---|---|---|---|
| 1 | `swapKeeper()` — field↔field, `gkActual` only | Req 1 | ~10 lines + picker | Ships alone, needs no pitch, closes finding 1.2 before it can be opened |
| 2 | Loud stopped-clock state, fired on pause **and** period expiry | Req 6 | ~3 lines CSS + 1 class | No new state, no arithmetic that can go wrong |
| 3 | Shrink the play clock; secondary wall-clock "ends ≈ 11:05" | Req 5 | ~2 lines + CSS | Frees the screen space items 1, 6 and 7 all need — do it before them, not after |
| 4 | Extract `buildLineup` / `subNow` / `tally` behind `node --test` | — | small | Everything after this touches the fairness ledger; nothing currently guards it |
| 5 | D1 schema + append-only outbox; game log read view | Req 2 | medium | Unblocks item 6 — the season ratio cannot exist without it |
| 6 | Positions GK/D/F: builder seeds them, ratio read from D1 | Req 3 | ~4 lines in the `q` loop + a query | Drag becomes the override, per the reviewer's call |
| 7 | The pitch — **tap-to-select first**, drag only if tapping proves slow | Req 4 | largest | Last, because by now positions are real state |

Revision 3 inserts two items. Both are prerequisites for the BU5 side being usable at all, and
the keeperless flag has to exist before the builder starts seeding positions:

| # | Work | Requirement | Size | Why here |
|---|---|---|---|---|
| 1.5 | `format` preset per team — `keeper: false` kills GK end-to-end | BU5 | ~15 lines | Must land before item 6 seeds positions, and before item 1's picker assumes a keeper exists |
| 4.5 | Team switcher + `state.season`; `season`/`format` columns on `games` | Seasons, 2 teams | ~25 lines | Before the first D1 write, or the archive is unlabelled and has to be backfilled |

The original order was `4 → 1 → 3, 6 → 5, 2`. Item 4 was the largest and riskiest change on
the most-used screen, and it was a prerequisite the plan invented for itself.

Items 1–3 are independent of each other and of the backend. If nothing else gets built, those
three still fix the two scenarios you named most often and give subs and stats their space.
Item 1.5 is what makes the app usable for BU5 on a Saturday, so it jumps ahead of everything
archival if the BU5 season starts first.

---

## The backend — append-only archive beside the live doc

Per decision 3. The constraint that produced the original "no tables" recommendation is real
and does not go away: **game day must work with no signal.** The design that satisfies both is
not doc-*or*-tables, it is doc-*and*-tables with different jobs:

- **`teams.doc` stays exactly as it is** — roster, settings, the live game, the current
  lineup. Mutable, small, conflict-resolved by the existing `rev` check. Game day reads and
  writes only this, offline, as today.
- **New tables are an append-only archive.** Events are written to a local outbox first and
  flushed opportunistically on the existing push cadence. Append-only with client-generated
  ids means the writes are **idempotent** — retry is free, and there is no 409 story at all.
  This is strictly simpler than the union-merge the JSON-doc version would have needed
  (§2.2a), and it removes the 512 KB overflow trap (§2.2c) entirely.

```sql
-- One row per game played. Written once at kickoff, updated at full time.
CREATE TABLE IF NOT EXISTS games (
  id          TEXT    PRIMARY KEY,          -- client-generated, so kickoff works offline
  team_id     TEXT    NOT NULL,
  season      TEXT    NOT NULL,             -- "Fall 2026" — the ledger reset boundary
  format      TEXT    NOT NULL,             -- "u8" | "bu5" — decides whether GK is meaningful
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  opponent    TEXT,
  us          INTEGER NOT NULL DEFAULT 0,
  them        INTEGER NOT NULL DEFAULT 0,
  periods     INTEGER NOT NULL,
  onfield     INTEGER NOT NULL,
  minsper     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_games_team ON games(team_id, season);

-- Requirement 2. Append-only; never updated, never deleted.
CREATE TABLE IF NOT EXISTS game_events (
  id        TEXT    PRIMARY KEY,            -- client-generated => POST is idempotent
  game_id   TEXT    NOT NULL,
  at        INTEGER NOT NULL,               -- ms epoch, client clock
  period    INTEGER NOT NULL,
  secs      INTEGER NOT NULL,               -- clock remaining when it happened
  kind      TEXT    NOT NULL,               -- goal | sub | keeper | period | clock
  player_id TEXT,
  detail    TEXT                            -- JSON, kind-specific
);
CREATE INDEX IF NOT EXISTS ix_events_game ON game_events(game_id, at);

-- Requirement 3. The table that makes a season-long position ratio possible at all.
-- pos is in the key because a mid-period sub splits one period across two positions.
CREATE TABLE IF NOT EXISTS appearances (
  game_id   TEXT NOT NULL,
  player_id TEXT NOT NULL,
  period    INTEGER NOT NULL,
  pos       TEXT NOT NULL,                  -- GK | D | F
  frac      REAL NOT NULL DEFAULT 1,        -- 0.7 when they came off at 3:00 of 10:00
  PRIMARY KEY (game_id, player_id, period, pos)
);
CREATE INDEX IF NOT EXISTS ix_app_player ON appearances(player_id, pos);
```

Requirement 3 then collapses to one query, scoped to the team **and** the season so the two
squads and two seasons never bleed into each other:

```sql
SELECT player_id, pos, ROUND(SUM(frac), 1) AS periods
FROM appearances
WHERE game_id IN (SELECT id FROM games WHERE team_id = ? AND season = ?)
GROUP BY player_id, pos;
```

`ROUND(..., 1)` per decision 6 — `D 4.7 · F 1.3` is the intended display, not a rounding
artefact to hide.

New endpoints, mirroring the existing style in [`worker.js`](../src/worker.js):

| Route | Job |
|---|---|
| `POST /api/team/:id/games` | Upsert the game row (kickoff, then full time) |
| `POST /api/team/:id/events` | Batch append; `INSERT OR IGNORE` on `id` makes retry a no-op |
| `POST /api/team/:id/appearances` | Batch upsert at period end and on every sub |
| `GET /api/team/:id/games` | Season list — the read view Req 2 needs |
| `GET /api/team/:id/games/:gid` | One game's events, in order |
| `GET /api/team/:id/positions` | The ratio query above |

**No `players` table.** The roster is small, mutable, and already conflict-resolved in the
doc; `player_id` here is a soft reference with no FK. Add one when a player needs attributes
the doc can't hold. *ponytail: three tables is the minimum that answers reqs 2 and 3 — a
`players` table and a `seasons` table are the two most tempting additions and neither has a
caller yet.*

Two things this must not skip, since both are trust-boundary work: `team_id` has to be
validated against `ID_RE` on every new route exactly as
[`worker.js:34`](../src/worker.js#L34) does today, and the batch endpoints need a length cap
so one bad client can't insert unbounded rows.

---

## Two teams, two formats — seasons, rosters, and a keeperless mode

Added in revision 3. The coach runs a **U8** side and a **BU5** side concurrently.

### Multiple teams is mostly already built

Worth stating before adding anything: the token model already gives each team its own D1 row
and its own `localStorage` namespace — `KEY = BASE + ":" + TEAM`
([`:610-611`](../public/app.js#L610-L611)), token from the URL hash
([`:492`](../public/app.js#L492)). Two teams already means two links that already do not
interfere. `state.played` / `state.kept` are per-doc, so the fairness ledgers are **already**
correctly separated per team.

The only real gap is that [`initSync`](../public/app.js#L586-L598) remembers exactly one
team: `localStorage[BASE+":lastTeam"]`. Extending that single key to a list is the whole
feature.

```js
// BASE+":teams" = [{tok, name, format}] — replaces the single ":lastTeam" key
// ponytail: a <select> in the header, set the hash, location.reload().
// Re-entering boot()/initSync() in place is where the bugs would live; a reload is free here.
```

Migration is one line: on first run, promote an existing `:lastTeam` into the list.

**Known limitation, unchanged from today:** the team list lives only in `localStorage`. Lose
the phone and you lose the index of your teams — the tokens themselves are the only handle,
exactly as [the README](../README.md) already documents ("treat it as the password"). A
server-side team list needs real auth, which is out of scope. Mitigation for now is the
existing **Copy team link**; two teams means two links to keep somewhere safe.

### Seasons

A season is a **reset boundary for the career ledgers**, nothing more. `state.played` and
`state.kept` accumulate forever today ([`:91-92`](../public/app.js#L91-L92)), so without one,
last season's minutes keep biasing this season's rotation.

- `state.season` on the doc — a string, `"Fall 2026"`.
- A **Start new season** action: bank the current game via the existing `commitGame`, zero
  `played`/`kept`, keep the roster. Around six lines, and it reuses the banking path that
  already exists rather than adding a second one.
- `games.season` stamps the archive, so history stays queryable after the reset.

**No `seasons` table.** It would hold a name and two dates that nothing queries. *ponytail:
add it when a season needs attributes — registration windows, a schedule — not before.* This
also settles the "Still open" question from revision 2 in the opposite direction from the
earlier lean: an explicit column beats deriving from `started_at`, because a season boundary
is a decision, not a date lookup.

### The keeperless format

BU5: same everyone-plays fairness, **no goalkeepers**.

This is not a BU5 special case. The U8 guide already needs it — *"Referee present: no ref
means no goalkeeper this match"* ([`index.html:202`](../public/index.html#L202),
[`:226`](../public/index.html#L226)). One flag serves the BU5 season permanently and a
ref-less U8 Saturday occasionally, which is the argument for a flag rather than a second app.

```js
var FORMATS = {
  u8:  { label:"U8 · 6v6 w/ keeper", keeper:true,  periods:4, onfield:6, minsper:10 },
  bu5: { label:"BU5 · no keeper",    keeper:false, periods:4, onfield:4, minsper:8  },
};
```

⚠️ **The BU5 numbers above are placeholders.** Region 630's BU5 format is not in
`Fall 2026 - Guide for Coaching U8.md` — that document is U8-only. Confirm periods, on-field
count and period length before the first game. The values are editable in the UI regardless,
so a wrong default is a nuisance rather than a blocker.

Where `keeper:false` actually reaches — smaller than it looks, because the code already
tolerates a missing keeper in most places:

| Site | Change |
|---|---|
| [`:138-139`](../public/app.js#L138-L139) builder | `lu.gk.push(null)` instead of running the picker — the one substantive change |
| [`:200`](../public/app.js#L200) table badge | Already safe: `gk[q]===p.id` never matches `null` |
| [`:216`](../public/app.js#L216) legend | Drop the "in goal — one period each" line |
| [`:372`](../public/app.js#L372) field chip | Already safe: `isGk` false throughout, chips number 1..N |
| [`:376`](../public/app.js#L376) "In goal" row | Hide the row; today it would render `—` |
| [`:385`](../public/app.js#L385) "Next keeper" | Hide |
| [`:168-172`](../public/app.js#L168-L172) `subNow` GK branch | Dead when `gk[pi]` is null — no change needed |
| `swapKeeper` (item 1) | Not offered |
| [`:252-261`](../public/app.js#L252-L261) `renderFormatNote` | Currently hardcodes `std=(Q===4&&N===6)` and U8 prose. Must read from the preset |
| [`index.html:212-276`](../public/index.html#L212) Rules tab | U8-only today. Needs a BU5 variant; keep it short — it is a reference card, not a CMS |
| Kickoff checklist [`:195-205`](../public/index.html#L195) | The "no ref ⇒ no goalkeeper" line is U8-specific; drop it for BU5 |

`totKept` / `state.kept` need no guard — they stay at zero and no BU5 UI reads them.

`posAt` from §3.2 takes the flag:

```js
function posAt(i, N, keeper){
  if(keeper) return i===0 ? "GK" : i<=Math.ceil((N-1)/2) ? "D" : "F";
  return i < Math.ceil(N/2) ? "D" : "F";     // BU5: 4v4 -> D,D,F,F
}
```

One consequence worth naming: with no keeper, **`appearances.pos` only ever holds D or F for
BU5**, so the same ratio query and the same display serve both squads with no branching. The
`pos` column needs no constraint change.

---

## Severity 1 — false claims the plan was built on

### 1.1 "Slot 0 is the goalkeeper" is false — FALSE

[`app.js:138-139`](../public/app.js#L138-L139) picks the keeper independently of slot index
and stores it in a **parallel array**:

```js
lu.gk.push(f.filter(function(id){ return lu.gk.indexOf(id)<0; })
            .sort(function(a,b){ return totKept(lu,a)-totKept(lu,b); })[0] || f[0]);
```

The keeper is *"lowest career `totKept` among the six on the field"*, not *"the first one"*.
Game 1 appears to work by accident — `state.kept` is all zeros, the filter preserves `f`
order, and a stable sort on equal keys leaves the first element first. The moment `kept` has
any variance, which is the entire purpose of [`app.js:81`](../public/app.js#L81), the
invariant collapses on every period:

```
game 2:  P1 gk=Neel    slotIndex=1
         P2 gk=George  slotIndex=1
         P3 gk=Zendrix slotIndex=1
         P4 gk=Oliver  slotIndex=1
```

Worse than "sometimes wrong": `lu.gk[]` is the real source of truth, consumed at
[`:200`](../public/app.js#L200) (table badge), [`:372`](../public/app.js#L372) (field chip),
[`:376`](../public/app.js#L376) ("In goal"), [`:385`](../public/app.js#L385) ("Next keeper")
and [`:139`](../public/app.js#L139) (the GK fairness sort itself). Adopting the slot
convention creates **two competing sources of truth for one fact** — drag slot 0 to slot 5
and the pitch says one keeper while the table and subline say another.

`subNow` makes it a third contradiction: [`:165`](../public/app.js#L165) writes the incoming
player into the *outgoing* player's index, so after any sub the keeper sits wherever the sub
happened to land.

**Fix:** either make `buildLineup` emit position-ordered arrays and derive
`lu.gk[q] = lu.periods[q][0]`, deleting the parallel array (a schema change touching six
call sites plus [`migrate()`](../public/app.js#L28) and `adoptServer`), or add an explicit
`lu.pos[q]` map. Not free either way — budget it honestly.

### 1.2 The keeper swap as planned corrupts the fairness ledger — BROKEN

The plan said item 1 "extends the existing keeper branch in `subNow()`", picking from the
other five **on-field** players. [`subNow`](../public/app.js#L158-L178) is a bench→field
function. Run verbatim on a field↔field swap:

```
before: field=[Bearett,Neel,Jeffrey,Oliver,Reyansh,Zendrix]  gk=Bearett
        actual Bearett=3  Neel=3
after : field=[Neel,Neel,Jeffrey,Oliver,Reyansh,Zendrix]     gk=Neel
        actual Bearett=2  Neel=4
        distinct players on field: 5 of 6
        renderLineup shows Bearett as BENCHED in P1
```

Three failures from [`:165-167`](../public/app.js#L165-L167):

- `lu.periods[pi][at]=inId` — Neel occupies two slots; Bearett vanishes from a period he is
  physically playing. [`:211`](../public/app.js#L211) still reports "6 on field".
- `lu.actual[outId] -= frac` — Bearett **loses** credit for time he is on the field. At
  kickoff `frac === 1`, so he loses the whole period.
- `lu.actual[inId] += frac` — Neel is credited 4 of 4 in a game he plays 3 of.

This inverts the app's single most important guarantee ("Everyone Plays",
[`index.html:33`](../public/index.html#L33)) via the feature meant to serve the coach's
most-cited problem.

**Not reachable today** — `#subIn` is populated from the bench only
([`:393`](../public/app.js#L393)) — so this is latent, not a live bug. It goes live the
moment item 1 is wired up as originally described.

**Fix:** a separate function, not an extension. `lu.periods` must not be touched at all,
because nobody left the field:

```js
function swapKeeper(newId){                       // both already on the field
  var lu=state.lineup, pi=Math.min(state.game.period-1,lu.Q-1), old=lu.gk[pi];
  if(!old||old===newId||lu.periods[pi].indexOf(newId)<0) return;
  var frac=Math.min(1,Math.max(0,state.game.secs/Math.max(1,state.minsper*60)));
  lu.gk[pi]=newId;                                 // periods[] untouched
  lu.gkActual[old]=(lu.gkActual[old]||0)-frac;
  lu.gkActual[newId]=(lu.gkActual[newId]||0)+frac;
  save(); renderLineup(); renderGame();
}
```

Three follow-ons:
- `subNow` needs a guard rejecting an `inId` already in `lu.periods[pi]`, because item 7's
  bench→field drag would otherwise route a mis-dropped token into the bug above.
- `subNow` reads `#subOut`/`#subIn` from the DOM ([`:160`](../public/app.js#L160)). "Reuses
  `subNow()`" quietly requires refactoring it to `subNow(outId, inId)` first.
- The picker should show `lu.gkActual[id]` — the per-game number the guide caps at one — not
  career `totKept`. The plan named the wrong one.

Still missing entirely: any way to change a **future** period's keeper, even though
[`:385`](../public/app.js#L385) advertises "Next keeper" to the coach.

### 1.3 A season-long position ratio cannot be derived — FALSE

The plan: *"Once slots mean positions, the ratio is purely derived — no new state."*

There is no per-game archive. `state.played` and `state.kept` are `{id: number}` scalars
([`:21-22`](../public/app.js#L21-L22)). [`commitGame`](../public/app.js#L89-L93) folds the
finished game into those scalars, then [`:147`](../public/app.js#L147) *replaces*
`state.lineup` wholesale. Last game's `lu.periods` is unrecoverable.

The maximum derivable window is the current game — four periods. The plan's own worked
example (`GK 1 · D 5 · M 2 · F 0`) sums to 8 and is arithmetically impossible under its own
model.

**The larger miss:** requirement 3 says every kid gets time in all positions *"even if they
naturally are skilled at one."* The plan's answer was a read-only column plus "the builder
ignores it; coach reads and drags" — asking a volunteer to hand-place 6 tokens × 4 periods ×
~10 games while tracking 8 kids across 4 buckets. That also contradicts the app's whole
design, which does the fairness math and shows the result: see
[`owedSet`](../public/app.js#L192), the "owed most" sentence
([`:246`](../public/app.js#L246)), and the GK rotation at
[`:138-139`](../public/app.js#L138-L139) — which already solves exactly this problem, for one
position.

**Fix — as decided (decisions 2 and 4).** Positions are **GK, D, F**. No midfield: per the
coach, those are the only three an eight-year-old will reliably hold. GK is already capped at
one period per game by the builder ([`:138`](../public/app.js#L138)) and by the guide; D and F
carry no cap and exist purely as a ratio to inform a judgement call.

History lives in the `appearances` table, not the doc — that is what makes the season query
possible (see [The backend](#the-backend--append-only-archive-beside-the-live-doc)). The doc
keeps only a cached copy for offline display, so a signal-less Saturday still shows last
week's numbers.

Per decision 4, the builder **seeds** the rotation rather than leaving it to the coach,
mirroring the goalkeeper picker it already contains — one sort inside the existing `q` loop,
least-experienced-at-that-position first. Drag is the override, not the mechanism.

The display stays a ratio, deliberately: `Bearett — D 5 · F 1`, coloured when a bucket is
empty. Nothing is enforced. That is the requirement as stated ("this isn't a hard rule").

---

## Severity 2 — the plan's mechanisms don't survive normal use

### 2.1 Routine actions silently destroy hand-arranged positions — BROKEN

The plan never mentions [`refreshLineup()`](../public/app.js#L154), called on **delete
player** ([`:402`](../public/app.js#L402)), **IN/OUT toggle**
([`:403`](../public/app.js#L403)), **add player** ([`:434`](../public/app.js#L434)) and **any
settings change** ([`:441`](../public/app.js#L441)).

Pre-kickoff, [`frozenUpto()`](../public/app.js#L96-L101) returns 0 — `underway` is
`g.started || g.period>1 || g.us || g.them`, all false — so the whole sheet is rebuilt from a
fresh object at [`:123`](../public/app.js#L123):

```
after the coach drags P1 (slot0 <-> slot5):
  P1 [GK:Zendrix] D:Neel,Jeffrey M:Oliver,Reyansh F:Bearett
--- coach taps IN/OUT on a late arrival (app.js:403 -> refreshLineup) ---
frozenUpto() = 0 -> periods kept = 0
  P1 [GK:Bearett] D:Neel,Jeffrey M:Oliver,Reyansh F:Zendrix   <-- drag undone, silently
```

That is precisely the requirement-1 scenario: fix the keeper before kickoff, mark a late
arrival IN, lose the fix with no toast and no confirmation. The prominent **↻ Reshuffle**
button ([`index.html:95`](../public/index.html#L95)) does the same to all unfrozen periods
mid-game.

Mid-game history *is* protected — frozen periods survive verbatim, and that part of
`frozenUpto` is sound. But a subtler leak remains: because `subNow` overwrites a slot, a
derived position count credits only the **final occupant**. A child who plays 7 minutes at
forward then subs off has no forward record, while `lu.actual` carefully records their 0.7.
The honest ledger and the derived one disagree by construction.

**Fix:** positions must be state that survives rebuilds (§1.3). Minimum stopgap: warn on
Reshuffle and pre-kickoff rebuild when a hand-arrangement exists.

### 2.2 The game log inherits last-write-wins, and overflow reads as "Offline" — BROKEN

The 512 KB arithmetic is roughly right and roughly irrelevant. One event ≈ 96 chars, so
~5,461 fit `MAX_DOC_BYTES` ([`worker.js:7`](../src/worker.js#L7)) against a current doc of
~932 chars. Five problems the plan didn't address:

**a) Concurrent edits destroy one side's log.** [`adoptServer`](../public/app.js#L552-L561)
does `state = incoming` — wholesale replacement. The 409 dialog
([`:523-527`](../public/app.js#L523-L527)) offers "use the other device's version" vs
"overwrite the other". Defensible for roster and score, which are small and re-enterable.
An append-only event log is the one payload where LWW is uniquely destructive *and* where
merge is trivial — union by timestamp, about six lines. The plan's own argument against SQL
("a second conflict story") is inverted here: the log needs a *different* conflict story.

**b) It never resets or prunes.** The plan put it at `state.game.log`, but the new-game reset
at [`:148`](../public/app.js#L148) touches only `period/us/them/running/started/secs`. It
would accumulate across the season.

**c) Overflow is invisible.** At 512 KB the worker returns 413
([`worker.js:69`](../src/worker.js#L69)); [`:530`](../public/app.js#L530) throws,
[`:534`](../public/app.js#L534) catches, the pill reads **"Offline — will sync"**, and
`scheduleRetry` retries every 15 s forever. The coach sees a connectivity blip; the data is
permanently unsyncable. Compounding: `saveLocal` swallows `QuotaExceededError` in a bare
`catch(e){}` at [`:38`](../public/app.js#L38), so a full localStorage silently no-ops every
save and a reload loses the lot.

**d) "Syncs free" is false.** `push()` re-uploads `JSON.stringify(state)` in full
([`:519`](../public/app.js#L519)) on a 1.2 s debounce. 150 events per game ≈ 1 MB of cell
data for ~14 KB of information, plus 150 D1 row writes.

**e) There is no read path.** The plan defined `logEvent` and stopped. A write-only array
that never renders does not satisfy "keep a log of the game".

`tick()` is correctly left alone — [`:350`](../public/app.js#L350) already uses `saveLocal()`
not `save()`, with a comment saying why — so the per-second concern doesn't materialise. But
item 2's pause/resume logging lands in `toggleTimer`, which *does* call `save()`.

**Fix — superseded by decision 3.** The log goes to `game_events`, not the doc. That answers
(a), (b), (c) and (d) outright: append-only rows with client-generated ids have no conflict
story, no accumulation inside a synced payload, no 512 KB ceiling, and no full-document
re-upload per event. Only **(e), the read view, still has to be built** — a write path with
nothing to read remains the way to miss requirement 2, whichever storage it lands in.

The findings above are kept because they are the cost of the *rejected* design, and because
(c) and its `saveLocal` companion at [`:38`](../public/app.js#L38) are live bugs in the
current app regardless: a full localStorage silently no-ops every save today, and a 413
already presents as "Offline — will sync" forever. Worth fixing on their own merits.

### 2.3 `pausedAt` misses the case the requirement names, and survives reload and sync — BROKEN

The requirement is *"if I forget to resume the play clock **after a period**."* The plan
stamped `pausedAt` in `toggleTimer` — but period expiry sets `g.running=false` directly at
[`:348`](../public/app.js#L348), **never touching `toggleTimer`**. The most common forgotten-
clock case (period ends → sub break → coach forgets Period + and Start) would never fire the
nag. The design misses the literal requirement.

Both survival claims fail:

- [`boot()`](../public/app.js#L614) forces `running=false` but does **not** clear `pausedAt`,
  which lives in `state.game` and is persisted. Phone locks 20 minutes, PWA evicted, coach
  reopens: *"Paused 20:00 ago"* with a one-tap *"Resume −20:00"* that zeroes the period. And
  the clock genuinely *was* running for part of that — `anchor` is module-local, reset by
  `startTicker` ([`:352`](../public/app.js#L352)) and never persisted — so reload already
  under-counts. The plan converts a silent under-count into an offered over-correction.
- [`adoptServer`](../public/app.js#L558) likewise forces `running=false` without clearing
  `pausedAt`, and that value came from **another device's wall clock**. `Date.now()` skew
  between two phones makes *"Paused −0:14 ago"* reachable.

**Is the deduction even right?** `g.secs` is *remaining* time and is not decremented while
paused (`tick` returns at [`:343`](../public/app.js#L343)). A long pause costs the period
nothing — `g.secs` is already correct. "Resume −4:12" asserts the clock *should* have been
running, which is true only if the coach forgot, and exactly wrong for a deliberate pause
(injury, goal celebration, halftime). The app cannot tell them apart, and the destructive
button is one gloved tap away. `g.secs -= 252` can also go negative: `updateClock` clamps the
*display* ([`:335`](../public/app.js#L335)) but `tick` at `:348` then ends the period
immediately.

"Nearly free because `tick()` is wall-clock anchored" is a non-sequitur — the anchor at
[`:344-346`](../public/app.js#L344-L346) handles background throttling *while running* and
does nothing for pauses.

**Fix, cheapest first:** the clock turns green while running
([`app.css:288`](../public/app.css#L288)) but a paused clock is plain white, which reads as
normal. Make the stopped state loud — pulsing amber, "CLOCK STOPPED" — fired on **both**
manual pause and period expiry. Three lines of CSS, one class in `updateClock`, no new state,
and it covers most of requirement 6. If the deduction still earns its place after that:
clamp with `Math.max(0, …)`, clear `pausedAt` in both `boot()` and `adoptServer()`, ignore
cross-device values, and label the button as what it is — *"Clock was left stopped — add 4:12
of play back"*.

---

## Severity 3 — smaller defects

### 3.1 `maxP` is undefined, and half of item 5 already ships — RISKY (scope reduced)

**Resolved by decision 1.** The requirement is walked back: the play clock gets *smaller*, and
the only addition is a secondary wall-clock readout of when the game ends. The
"time-to-end-of-quarter" bullet below is dropped — the big clock already is that number. The
freed space is the point, and it is why this moved to position 3 in the build order: items 1,
6 and 7 all want room the scoreboard is currently spending on a 10:00 that is legible from
twice as far away as it needs to be.

The remaining bullets still apply to the wall-clock projection, which is now the whole item.

`var left = g.secs + (maxP - g.period) * state.minsper * 60;`

- **`maxP` is never defined in the plan.** [`nextPeriod`](../public/app.js#L460) computes it
  as `state.lineup ? state.lineup.Q : state.periods`, and the two genuinely diverge:
  `syncSettings` ([`:437`](../public/app.js#L437)) sets `state.periods` then calls
  `refreshLineup()`, but `buildLineup` early-returns at
  [`:110-120`](../public/app.js#L110-L120) when fewer than `onfield` are present, leaving
  `lu.Q` stale. Factor the expression out; don't derive it a third time.
- **`state.minsper` vs `lu.minsper`** — [the prior audit](./coaching-guide-audit.md) already
  flagged this split ("the sheet and the clock can disagree"). `state.minsper` is right for a
  clock projection, but the new full-time number will then contradict the `(Q*mp)` printed
  from `lu.minsper` at [`:214`](../public/app.js#L214). Reconcile, or §1.4 of that audit is
  back.
- **Paused is the common case and it's broken.** `end` is recomputed on render, but rendering
  runs from `updateClock()` ← `tick()`, which returns immediately when `!g.running`. While
  paused — most of the between-play time — "ends at" freezes and goes stale. Needs its own
  interval. Not free.
- **`g.secs === 0`:** the formula is right, but `toggleTimer`
  ([`:453`](../public/app.js#L453)) refills `g.secs` *without* incrementing the period, so
  tapping Start after expiry replays the period and the projection jumps a full period later.
- ~~**"Time to end of quarter" already exists**~~ — correct, and now moot: the requirement
  was withdrawn once this was pointed out. The big clock *is* the quarter countdown
  ([`:335-339`](../public/app.js#L335-L339)).

The volunteered break-drift caveat was honest, but a fixed constant is still unbounded error,
just differently biased. The real source is accumulated pause time — item 2's state. The plan
treated 5 and 6 as independent when they share the one variable that makes 5 accurate. With
the item reduced to a single projected time, label it as an estimate (`ends ≈ 11:05`) and let
item 2's pause accounting sharpen it rather than guessing at break lengths.

### 3.2 The position map only exists at `onfield === 6` — RESOLVED by decision 2

[`index.html:85`](../public/index.html#L85) offers On field 3–7;
[`:81`](../public/index.html#L81) offers Periods 2–6. The map (0=GK, 1-2=D, 3-4=M, 5=F) is
meaningless at N=3, 4 and 5, and leaves slot 6 unmapped at N=7.

The app **actively tells the coach to leave 6**: the blowout nudge at
[`:331`](../public/app.js#L331) recommends dropping to `state.onfield-1`, per the guide.
Follow the app's own advice and the pitch labels become fiction. Short-handed builds are
worse — [`:115`](../public/app.js#L115) pushes literal `[]` periods, so slot indexing must
survive an empty array.

**Fix:** dropping midfield collapses this to one line — no table needed. One keeper, the rest
split with the extra going to defense:

```js
// ponytail: GK/D/F only, so the map is arithmetic, not a lookup table
function posAt(i, N){ return i===0 ? "GK" : i <= Math.ceil((N-1)/2) ? "D" : "F"; }
// N=3 GK,D,F   N=4 GK,D,D,F   N=5 GK,D,D,F,F   N=6 GK,D,D,D,F,F   N=7 GK,D,D,D,F,F,F
```

Valid across the whole 3–7 range the selector offers, including the reduced side the blowout
nudge recommends. The `[]` short-handed case at [`:115`](../public/app.js#L115) still needs a
length guard before any slot is read.

Revision 3 adds a `keeper` argument for the BU5 side — see
[the keeperless format](#the-keeperless-format).

### 3.3 Drag may be worse than the chip list under real conditions — RISKY

- **Touch targets.** `.jchip` is `padding:5px 12px; font-size:13px`
  ([`app.css:306`](../public/app.css#L306)) ≈ 30 px tall, already under the 44 px iOS
  minimum. `.gd-grid` is single-column on mobile, so on a 390 px phone `.field-mini` has
  ~330 px usable. Six tokens land near 40 px with ~20 px gutters. Fine bare-handed indoors;
  not with gloves, one-handed, while watching the field.
- **`touch-action` is set nowhere in `app.css`.** Pointer drag needs `touch-action:none` on
  the tokens or the page scrolls instead — and once set, the pitch is a large no-scroll dead
  zone on a narrow phone.
- **Re-render mid-gesture.** The event model is one delegated `click` handler
  ([`:398`](../public/app.js#L398)) plus full `innerHTML` re-renders. `adoptServer` →
  `renderAll()` can fire from the `visibilitychange` pull
  ([`:605`](../public/app.js#L605)) and rip the DOM out from under an active pointer capture.
  Two phones is the whole point of the sync feature.
- **Sunlight.** The pitch is `--accent-deep` with white tokens, and the app auto-switches to
  a dark theme. A wrapping row of text chips is legible at arm's length; a 40 px token on
  dark green in October afternoon sun is not. No text fallback, no high-contrast mode.
- **Gaze cost.** Drag needs 3–4 seconds of sustained downward attention. Tap-source then
  tap-destination is forgiving, interruptible, resumable, glove-friendly, and ~10 lines
  instead of ~40. *"Like the Goalie Soccer Coach app"* is a stated preference, not evidence
  that drag wins on a U8 sideline.
- **Accessibility.** The app otherwise cares — `role="tablist"`, `aria-selected`, `aria-label`
  on [`diagram.js:7`](../public/diagram.js#L7). A pointer-only SVG pitch has no keyboard or
  screen-reader path.
- **Print.** [`printPanel`](../public/app.js#L475) produces the sheet the coach carries, and
  `renderLineup` emits only ✓/GK ([`:199-201`](../public/app.js#L199-L201)). Hand-dragged
  formations would be invisible on paper.

**Fix:** ship tap-to-select / tap-to-place on the existing chips first. Add the pitch after,
gated behind a large-touch-target layout rather than scale-to-fit.

### 3.4 Assorted

- **`#subNow` hides when there is no bench** —
  [`:394`](../public/app.js#L394): `!bench.length || !onNow.length`. With exactly `onfield`
  players present there is no bench, and a keeper swap needs none. Bolting item 1's picker
  into that card hides it in the case it's most needed.
- **Zero frontend test coverage.** `test/worker.test.mjs` is the only test. Every claim in
  §1.1–1.3 had to be verified by transcribing functions into a scratch harness. A plan that
  rewrites fairness-adjacent code should extract `buildLineup`/`subNow`/`tally` into
  something testable *first* — the highest-leverage item in the queue, and it wasn't in the
  plan.
- **`sw.js` precaches an explicit SHELL list.** No new files are proposed, so this is fine
  today — but if the pitch grows its own file, [`sw.js`](../public/sw.js) must be updated or
  the cold offline launch breaks. Its own comment says so.
- **Dead ids render as `?`.** After a delete, frozen periods keep the id
  ([`:143`](../public/app.js#L143)) and `nm()` returns `"?"`
  ([`:369`](../public/app.js#L369)). The pitch would show "?" tokens where the plan promises
  it "visually shows where kids are supposed to be".

---

## What survived review

- **Refusing the SQL tables is correct**, and for a defensible reason: the app genuinely runs
  with no backend ([`:482-483`](../public/app.js#L482-L483), health probe at
  [`:495`](../public/app.js#L495)), and game day must not depend on connectivity. The
  second-write-path argument holds. Only "and therefore it's free" was wrong.
- **Extending `diagram.js` rather than adding a drag library** — right. It is pure and
  dependency-free ([`diagram.js:1-3`](../public/diagram.js#L1-L3)); a library would cost an
  order of magnitude more bytes than ~40 lines of Pointer Events.
- **Pointer Events over HTML5 `dragstart`** — right, for iOS Safari.
- **`frozenUpto()` protects played periods** — verified. `tally`/`commitGame`/`actual`-vs-
  `played` is a well-built ledger and the plan was right not to disturb it.
- **`tick()` really is wall-clock anchored** ([`:344-346`](../public/app.js#L344-L346)) — the
  claim is true; it just doesn't support the conclusion drawn from it.
- **The item-5 drift caveat was volunteered rather than buried.**

---

## Decisions

Answered by the coach, 2026-08-03. These are settled; the sections above have been updated to
match.

**1. Requirement 5 is walked back.** *"Reduce the size of the play clock — substitutions and
stats need more screen space. Just show the wall-clock until game ends as a secondary time."*
→ The scoreboard shrinks. One new readout: `ends ≈ 11:05`, labelled as an estimate. Moved to
build position 3 because the reclaimed space is what items 1, 6 and 7 are competing for.
Kills the "second quarter countdown" idea entirely (§3.1).

**2. Positions are GK, D, F.** *"The only positions we can realistically expect 8-year-olds to
follow. GK is one quarter per game max, the others are just ratios to help me decide."*
→ No midfield. GK stays capped by the existing builder and the guide. D and F have no cap and
no enforcement — they display as a ratio and nothing else. Collapses §3.2 to one line of
arithmetic that holds across the full 3–7 range.

**3. The backend gets real tables.** *"Build the backend to be robust and expandable to
support more features."*
→ Overrules both the plan and the reviewer. Three tables (`games`, `game_events`,
`appearances`), append-only, client-generated ids, flushed from a local outbox. The live doc
is untouched, so game day still works with no signal. The reviewer's objections to the
JSON-doc log (§2.2 a–d) are answered by construction rather than by mitigation. The read
view — §2.2(e) — is the one piece that still has to be built.

Recording the reversal plainly: the plan argued against tables and the reviewer agreed. Both
were wrong, for the same reason neither noticed — finding 1.3 proves the season ratio is
underivable without per-game history, and the plan proposed that ratio in the same breath as
rejecting the only storage that supports it.

**4. The builder seeds position rotation.** *"Agree with reviewer agent."*
→ Positions rotate automatically, mirroring the goalkeeper picker the builder already has.
Drag is the override, not the mechanism. The read-only column from the first-pass plan is
dropped.

**5. Seasons, and multiple teams per season.** *"I am also coaching a BU5 team."*
→ `state.season` on the doc as the ledger-reset boundary, `season` + `format` columns on
`games`. The team switcher extends the existing single `:lastTeam` key to a list; no new
storage model, because the token already namespaces everything. No `seasons` table yet.

**6. Fractional periods display to one decimal.** *"One decimal point doesn't sound too bad,
allow for 4.7-like values. We can iterate on this over the season."*
→ Reverses revision 2's "round in the display only". `D 4.7 · F 1.3` it is. This is the
honest number — `subNow` already credits fractions ([`:164`](../public/app.js#L164)) and the
lineup table already prints them via `r1()` ([`:179`](../public/app.js#L179)), so the season
ratio now matches what the game sheet has always shown. One fewer inconsistency, and it reuses
the existing helper.

**7. BU5 runs keeperless on the same codebase.** *"The rules are similar, but no goalies and
everyone still plays."*
→ A `keeper: false` format preset rather than a separate app or a separate rules engine. The
fairness ledger, the rotation builder, the clock and the position ratio are all format-neutral
already; goalkeeper handling is the only thing gated.

---

## Still open

- **Region 630's actual BU5 format.** Periods, on-field count and period length are
  placeholders. The U8 guide in this repo does not cover BU5. Confirm before the first game —
  everything else is downstream of these three numbers.
- **Whether BU5 wants position tracking at all.** With no keeper and 4v4, "defense" and
  "forward" are looser than at U8, and the reason for the feature — giving a natural forward
  time at the back — may matter less when every kid is chasing the ball anyway. Cheap to
  enable, so this is a "watch it for a few weeks" question rather than a design one.
- **Whether a keeperless U8 match should flip the flag per-game.** The guide's "no ref ⇒ no
  goalkeeper" rule is per-match, but `format` as designed is per-team. A per-game override is
  a checkbox and a column; not building it until it actually happens on a Saturday.

**Settled by revision 3:** the season-boundary question (explicit column, not derived from
`started_at`) and the fractional-display question (one decimal, per decision 6).
