# "Call the game out loud" — voice event log + LLM reporting

Status: **plan, not built.** Drafted 2026-08-03, adversarially reviewed, **blockers fixed 2026-08-03**.

The review found 2 blockers and 9 majors. Both blockers (#1 `esc()` shadowing, #2 pre-kickoff event wipe) are now corrected in the body below, along with #6 and #12 — they shared the same eight lines, and a half-fixed snippet reads as a safe one. **7 majors remain open** and still carry inline `⚠️ REVIEW #n` markers. Two of them (#3 alias stability, #8 season boundary) are data-model decisions that must be settled *before* task 1, because retrofitting either means rewriting archived data. Read [Adversarial review](#adversarial-review) before implementing.

Read first: `public/app.js` (621 lines, one IIFE), `src/worker.js` (107), `public/sw.js`, `schema.sql`, `docs/coaching-guide-audit.md`.

---

## The feature

Hold a button, say "goal Bearett", put the phone back in your pocket. The app speaks back "Bearett goal" so you never look down. That removes the reason you're heads-down — data entry — rather than adding another screen to watch.

Three layers:

1. **Event log, no LLM.** Push-to-talk speech recognition → match against the 8 roster names + a small verb set → append to a log → audible confirmation. Unrecognised utterances are logged verbatim as `note`, so nothing is lost.
2. **Post-game report, one LLM call.** `POST /api/report/:id` → Anthropic → per-player parent-facing paragraphs + a team recap the coach edits and pastes into the group text.
3. **Season commendations.** Same endpoint over the accumulated season.

The log also unlocks a nudge the guide explicitly asks for (line 72, *"let players who haven't scored yet take the shots"*) — the existing `renderNudge()` blowout warning can name players with no season goals.

---

## 0. The one decision that shapes everything else

The riskiest assumption is **not** the data model or the Worker. It's *"a phone browser will reliably turn 'Neel goal' into text, at a field, possibly with no signal."*

Web Speech recognition on both Chrome/Android and iOS Safari appears to be **server-based** — audio is uploaded, text comes back. If that holds, the voice layer **cannot work offline**, which collides head-on with the app's offline-first constraint.

The plan is therefore structured so voice is an *enhancement layer over one function*, `logEvent(kind, playerId, text)`, and the offline-safe fallback (tap a name chip, tap a verb chip — two taps, no network) drives the same function. If the airplane-mode test fails, you lose the voice layer and keep the feature. That costs nothing to design in and everything to retrofit.

---

## 1. Data model

### The event record

```js
// One thing the coach called out. No timestamp: array order gives ordering,
// the period gives the "when" a parent cares about, and a per-second trace of a
// seven-year-old is data we'd rather not hold.
{ player:"seed3", kind:"goal", period:2 }
{ player:"",      kind:"note", period:3, text:"great hustle back on defence" }
```

`kind` ∈ `goal | shot | assist | save | commendation | note`. `player` is a roster id (`""` when unattributed). `text` only on `note`.

Readable keys, not `{p,v,q}` — the byte budget below shows compression buys nothing, and short keys break the house style (`gkActual`, `playerOrder`, `minsper`).

### Where it hangs off `state`

Two places, mirroring the ledger split the app already uses:

| Data | Lives at | Analogue in existing code |
|---|---|---|
| This game's events | `state.lineup.events` (array) | `lu.actual` / `lu.gkActual` |
| Finished games | `state.games` (array) | `state.played` / `state.kept` |

```js
// state.games — one entry per finished game
{ date:1785000000000, us:4, them:2, events:[ … ] }
```

This is the right seam because `buildLineup(false,false)` already calls `commitGame(state.lineup)` at app.js:122 — the existing "the outgoing game goes on the books" hook. Extend it; don't add a parallel lifecycle.

### The lifecycle

- **app.js:123** — the fresh-lineup literal must *carry events across*, not initialise them empty. `frozenUpto()` returns 0 until the clock starts, so a pre-kickoff `replace=true` rebuild takes this branch too:

```js
// Events outlive the sheet. frozenUpto() is 0 until kickoff, so a pre-kickoff
// roster edit lands here with replace=true — initialising events:[] would bin
// everything called out during the warmup.
var lu = keep ? state.lineup : {periods:[],gk:[],actual:{},gkActual:{},
                                events:(replace&&state.lineup&&state.lineup.events)||[]};
```
- **app.js:122** `commitGame(state.lineup)` runs *before* :148 resets `g.us`/`g.them`/`g.period`, so the score is still the outgoing game's. The archive can read `state.game` directly.
- **`refreshLineup()` / reshuffle** use `replace=true` and never commit. **Mid-game** (`keep > 0`) they mutate `lu` in place, so `lu.events` survives for free. **Pre-kickoff** (`keep === 0` — `frozenUpto()` at :96-101 is 0 until `g.started || g.period>1 || g.us || g.them`) they fall through to the fresh literal above, which is why that literal carries events across. Every one of `toggle-present` (:403), `del-player` (:402), `addPlayer` (:434), `syncSettings` (:441), and ↻ Reshuffle (:405) routes here.
- **`commitGame`** gains ~5 lines:

```js
function commitGame(lu){
  if(!lu) return;
  … existing played/kept banking …
  // The voice log follows the same rule as the minutes: it only goes on the
  // books when the next game starts. Empty games (three taps of Build while
  // setting up) don't earn a row.
  var g=state.game;
  if((lu.events&&lu.events.length) || g.us || g.them){
    state.games.push({date:g.date||nowMs(), us:g.us, them:g.them, events:lu.events||[]});
    if(state.games.length>12) state.games.shift();   // a season is ~10 games
  }
}
```

- **app.js:148** add `g.date=nowMs();` to the new-game reset block, so the archived date is when the game was *played*, not when the next one was built. 12 characters, removes a wrong-data class.

### The `totPlayed` symmetry

`commitGame` only fires when the *next* lineup is built, so the most recent game is never in `state.games`. The existing code already lives with this — `totPlayed(lu,id)` adds `state.played[id] + lu.actual[id]`. Mirror it:

```js
// Same trick as totPlayed(): the game you're standing in hasn't been banked yet.
function allEvents(){
  var out=[];
  state.games.forEach(function(g){ out=out.concat(g.events); });
  return out.concat((state.lineup&&state.lineup.events)||[]);
}
```

### Byte budget

| | bytes |
|---|---|
| Event, no note | ~46 |
| Event with a 100-char note | ~155 |
| Realistic game (30 events, 3 notes) | ~1.7 KB |
| Realistic season (10 games) | ~17 KB |
| Existing doc (roster, lineup, practice, ledger) | ~3 KB |
| **Realistic season total** | **~20 KB** of 512 KB |
| Worst case with caps below (12 × 150 × 155 B) | ~288 KB |

Three constant caps, no cleanup loop:

- `text` truncated to 100 chars at capture (`s.slice(0,100)`)
- `lu.events` capped at 150 per game (drop the append, toast "log full for this game")
- `state.games` capped at 12 (`shift()` in `commitGame`)

Worst case lands under the cap with headroom. Don't write a doc-size-measuring trim loop; it's an abstraction for a case the constants already close.

**Backstop:** if the doc ever *does* exceed 512 KB, `putTeam` returns 413, and `push()` at app.js:530 does `if(!res.ok) throw` → `setPill("off","Offline — will sync")` → the app claims it's offline forever while silently never syncing again. Fix at :530:

```js
if(res.status===413){ setPill("local","Too big to sync"); toast("This team's history got too big to sync. Old games need trimming."); return; }
```

A permanently-silent sync failure is precisely what the README promises not to do.

---

## 2. Migration

### New saves on this device

`load()` at app.js:14: add `if(!s.games) s.games=[];` to the existing defensive block (`if(!s.played)…`), and `games:[]` to the default-state literal at :15.

### `migrate(s)` — watch the early return

`migrate` at app.js:28-35 begins `if(!s.lineup || s.lineup.actual) return;`. **Appending to its body does nothing for already-migrated saves.** New normalisations must go *above* the return:

```js
function migrate(s){
  if(!s.games) s.games=[];
  if(s.lineup && !s.lineup.events) s.lineup.events=[];
  if(!s.lineup || s.lineup.actual) return;      // ← existing guard, unchanged
  … existing actual/gkActual backfill …
}
```

### The sync question — old code vs a new doc

**`adoptServer()` at app.js:552 never calls `migrate()`.** That's a pre-existing latent bug (a doc synced from another device skips migration entirely) and the event log walks straight into it. One line at :555:

```js
state=incoming; migrate(state);
```

Now the real question: an old-code device (stale service-worker shell — `sw.js` is stale-while-revalidate, so the *very next launch after deploy* runs old `app.js`) syncing against a doc containing `games` and `lineup.events`.

> The doc is one JSON blob that old code `JSON.parse`s into `state` and `JSON.stringify`s back out. Old code never enumerates or filters fields. **Unknown fields round-trip intact for free.** The only way old code destroys new data is by *replacing a containing object*.

Auditing old `app.js` for containing-object replacement:

| Old-code path | Effect on new fields |
|---|---|
| `adoptServer` → `state=incoming` | Whole doc adopted; `games` + `lineup.events` intact |
| `save()` → `JSON.stringify(state)` | Round-trips intact |
| `buildLineup(replace=true)` **mid-game** (reshuffle, roster edit) | Mutates `lu` in place → `lu.events` **survives** |
| `buildLineup(replace=true)` **pre-kickoff** (`keep===0`) | Fresh literal → survives *only* because of the carry-across in §1 |
| `buildLineup(replace=false)` (**new game**) | Creates a fresh `lu` literal with no `events` → **that game's log is lost** |
| Short-handed branch at :116 (`state.lineup=null`) | Pre-game events lost (narrow) |
| Anything touching `state.games` | Nothing does. **Always survives.** |

**The loss window is exactly one action:** an old-code device pressing "Build lineup" (new game) while the current game has unarchived events. What's lost is one game's log — not the roster, not the fairness ledger, not the season archive.

Mitigation: document it and let it close on its own. `sw.js`'s fetch handler revalidates the shell on every launch, so every device is on new code by its second launch after deploy. Tell the coach to open the app once on the assistant coach's phone before the first voice-logged game.

**Explicitly rejected — a `state.v` version marker.** A version field only helps *new* code detect *old* docs, which `migrate()` already does structurally from the shape. Old code can't read a field it doesn't know exists. It buys nothing.

**Rejected for v1 — union-merging events on the 409 path.** Genuinely correct (events are append-only) and ~5 lines, but it produces a half-merged doc — events merged, everything else last-write-wins — which is more confusing than the current honest "pick a device" dialog. The README scopes this to one coach editing at a time.

Known small hole, flagged not fixed: the short-handed branch at :116 nulls `state.lineup` (correct for the ledger — `tally()` at :145 pre-credits the whole plan into `lu.actual`, so committing a never-played lineup would fabricate minutes). Pre-game events logged before that fires are lost. Edge-casey; leave it.

---

## 3. File-by-file change list

### `public/app.js` — everything goes here

**No new script file.** A `voice.js` would mean editing `index.html` *and* `sw.js`'s `SHELL` array — and sw.js's own comment warns that a missed `SHELL` entry breaks the cold offline launch. One file, zero new plumbing.

| Function / line | Change |
|---|---|
| `load()` :14-25 | `games:[]` in the default literal; `if(!s.games) s.games=[];` in the defensive block |
| `migrate(s)` :28 | Two normalisations **above** the existing early return |
| `commitGame(lu)` :89 | Archive `{date,us,them,events}` into `state.games`; cap at 12 |
| `buildLineup()` :123 | `events:[]` in the fresh-lineup literal |
| `buildLineup()` :148 | `g.date=nowMs();` in the new-game reset block |
| `renderNudge()` :326 | Append the "who hasn't scored" line |
| `renderGame()` :314 | Call `renderLog()` |
| `toggleTimer()` :451 | `keepAwake(g.running)` |
| `tick()` :348 | `keepAwake(false)` on the period-end stop |
| click handler :398 | `+ ptt`, `del-event`, `report` cases |
| `push()` :530 | Distinct 413 branch |
| `adoptServer()` :555 | `migrate(state);` |
| `visibilitychange` :605 | `if(state.game.running) keepAwake(true);` — wake locks auto-release on hide |
| **new** `/* ---- voice log ---- */` | `VERBS`, `logEvent`, `parseUtterance`, `speak`, `startListening`, `renderLog`, `allEvents`, `keepAwake`, `reportPayload`, `writeReport` |
| **new** `keydown` listener | Bluetooth shutter → `startListening()` |

**The single entry point** — voice, chip taps, and the shutter all funnel through:

```js
function logEvent(kind, playerId, text){
  var lu=state.lineup; if(!lu) return;
  if(lu.events.length>=150){ toast("Log full for this game"); return; }
  lu.events.push(text ? {player:playerId||"", kind:kind, period:state.game.period, text:text.slice(0,100)}
                      : {player:playerId||"", kind:kind, period:state.game.period});
  save(); renderLog(); renderNudge();
}
```

**Parsing — substring `indexOf`, nothing cleverer:**

> **⚠️ REVIEW #10 (Major):** both loops are last-match-wins, so `"great save"` logs as a commendation, `"nice shot"` as a commendation, and `"Neel to George"` credits George. Iterate verbs longest-first and `break`; take the *first* roster match by position in the utterance. The `" "+s+" "` padding is also dead code — nothing checks word boundaries, so `goal` matches "goalie".

```js
// A tiny word list beats a fuzzy matcher: if we don't recognise it we keep the
// coach's own words as a note, so nothing is ever lost by guessing wrong.
var VERBS={goal:"goal", shot:"shot", assist:"assist", save:"save",
           great:"commendation", nice:"commendation", good:"commendation"};
function parseUtterance(s){
  var t=" "+s.toLowerCase()+" ", p=null, v=null;
  state.roster.forEach(function(x){ if(t.indexOf(x.name.toLowerCase())>-1) p=x.id; });
  Object.keys(VERBS).forEach(function(w){ if(t.indexOf(w)>-1) v=VERBS[w]; });
  if(v) logEvent(v, p, null); else logEvent("note", p, s);
  speak(v ? (p?nameOf(p)+" ":"")+v : "noted");
}
```

If the rehearsal (§7 step 0) shows a name is *consistently* mangled, add an optional `alias` string to the roster record and one `|| t.indexOf(x.alias)` — not a Levenshtein matcher.

**Deliberate non-couplings** (say no once, in a comment):

- Logging a goal does **not** touch `g.us`. The score has +/− buttons; auto-scoring creates a desync class where the coach also taps + and the score doubles.
- `renderLog()` needs a **delete `×` per row** (`data-act="del-event"`, `data-i`, `splice`). Voice *will* mishear. An append-only log you can't correct is worse than no log. Render newest-first so the last event is under the thumb.

**The nudge** (`renderNudge` :326) — guide line 72:

```js
// Only once somebody HAS scored — otherwise "nobody has scored yet" names the
// whole team and tells the coach nothing.
var scored={}, any=false;
allEvents().forEach(function(e){ if(e.kind==="goal"&&e.player){ scored[e.player]=1; any=true; } });
if(any && d>0){
  var none=state.roster.filter(function(p){return p.present&&!scored[p.id];}).map(function(p){return p.name;});
  if(none.length) el.textContent += " Still looking for a first goal: "+none.join(", ")+" — feed them the shots.";
}
```

### `public/index.html`

One `<div class="card">` in the Game Day panel's left column, immediately after `#blowoutNudge` (:172) — the coach's eyes are already there, and it's thumb-reachable:

- Big `<button class="btn btn-start" data-act="ptt" id="pttBtn">🎙 Hold the game</button>`
- `<div id="eventLog"></div>`
- `<div class="row no-print" id="reportTools" hidden>` → two buttons `data-act="report" data-kind="game"|"season"`
- `<textarea id="reportOut" hidden rows="12">` + a copy button (reuse `copyTeamLink`'s clipboard pattern at :563)

**Textarea, not a `<div>`** — the coach must be able to edit AI-written text about kids before it reaches parents. That's a design requirement, not decoration.

No new `<script>` tags → `sw.js` `SHELL` untouched.

### `public/app.css`

Reuse existing tokens: `.card`, `.btn`/`.btn-start`, `.hint`, and the `.subline .r` row shape for log rows. Add roughly `#pttBtn.listening` (pulsing accent) and `.evrow` (period pill + name + kind + `×`). ~15 lines.

### `src/worker.js`

New route before the 404 at :44, reusing the existing `json()` helper and `{error:"…"}` convention. See §4.

### `package.json`

`"dependencies": { "@anthropic-ai/sdk": "^0.6x" }` — a **runtime** dependency. Wrangler already bundles the worker with esbuild; this is not a new build step.

### `README.md`

Voice-log bullet, the `/api/report/:id` entry in the API table, `npx wrangler secret put ANTHROPIC_API_KEY` in Deploy, and a line in Data & privacy about pseudonymisation.

### `wrangler.jsonc`

No change expected. **Flag:** if `npm run dev` fails on a `node:` builtin from the SDK, add `"compatibility_flags": ["nodejs_compat"]`. Verify locally before deploying.

---

## 4. The Worker route

### Shape

```
POST /api/report/:id
```

**Gate on the team token, reusing `ID_RE`.** The token is already the app's only password (README: "treat it as the password"). This turns "anyone who finds the URL can burn the owner's Anthropic credits" into "anyone with a share link can" — the same bar as every other endpoint, for four lines and one `SELECT`. `BACKEND && TEAM` are always both set by `initSync`, so it's free on the client.

**The client sends the payload; the Worker does not read the doc from D1.** Reading from D1 would introduce a sync race — the coach taps "write the report" seconds after the last event, inside the 1.2 s push debounce. "Probably synced" is a bug.

### Request

```json
{
  "kind": "game",
  "players": ["PLAYER_1","PLAYER_2","PLAYER_3","PLAYER_4"],
  "quartersPlayed": {"PLAYER_1":3.5,"PLAYER_2":3,"…":0},
  "games": [ { "events":[ {"player":"PLAYER_3","kind":"goal","period":2},
                          {"player":"","kind":"note","period":3,"text":"…"} ] } ]
}
```

One shape for both kinds — a game report is a one-element `games` array. No team name, no score (guide line 69: score isn't officially kept; a parent-facing recap that leads with "we won 4–2" is against the spirit, and dropping the field is strictly lazier).

`quartersPlayed` is the app's whole thesis in one field ("played 34 of 40 quarters this season") and costs nothing. It is **not** called `periods`: `period` on an event means the quarter it happened in, and two fields a word apart meaning different things is how a model gets it wrong.

**⚠️ REVIEW #8 (Major) — still open.** `quartersPlayed` as specced comes from `totPlayed()`, which is a *career* total that nothing ever resets, while `games` is capped at 12. Cross a season boundary and the report claims 68 quarters against 12 games. Derive it from `state.games` + the live lineup instead, so both fields describe the same span.

### Validation at the boundary

```js
if (request.method !== "POST") return json({error:"method_not_allowed"},405,{allow:"POST"});
if (!ID_RE.test(id))            return json({error:"bad_team_id"},400);
if (!env.ANTHROPIC_API_KEY)     return json({error:"no_api_key"},503);   // a fork without the secret gets a useful message, not a 500
const row = await db.prepare("SELECT 1 FROM teams WHERE id = ?").bind(id).first();
if (!row) return json({error:"not_found"},404);

let body; try { body = await request.json(); } catch { return json({error:"invalid_json_body"},400); }
if (body.kind!=="game" && body.kind!=="season") return json({error:"bad_kind"},400);
if (JSON.stringify(body).length > 64*1024)      return json({error:"payload_too_large"},413);  // bounds the token bill

// The names must already be pseudonyms. If the frontend ever regresses and sends
// real first names, the coach gets an error instead of a silent leak.
const ALIAS=/^PLAYER_\d+$/;
if (!Array.isArray(body.players) || !body.players.every(n=>ALIAS.test(n))) return json({error:"names_not_pseudonymised"},400);
for (const g of body.games||[]) for (const e of g.events||[])
  if (e.player && !ALIAS.test(e.player)) return json({error:"names_not_pseudonymised"},400);
// Check the map's keys too — a removed player leaves an "undefined" key here,
// and an unchecked field is exactly where the next regression leaks a name.
for (const k of Object.keys(body.quartersPlayed||{}))
  if (!ALIAS.test(k)) return json({error:"names_not_pseudonymised"},400);
```

That last check is the highest-value five lines in the Worker: it makes the privacy property *enforced at the boundary* rather than *hoped for in the frontend*, and it's trivially testable.

### The call

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  timeout: 60_000,   // ms. Default is 10 min; a coach on the sideline needs a
  maxRetries: 1,     // failure, not a hang. One retry, not three.
});

const msg = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: body.kind==="season" ? 8000 : 4000,
  output_config: { effort: "low" },
  system: SYS,
  messages: [{ role:"user", content: JSON.stringify(body) }],
});
```

**Three model-behaviour notes that will bite if missed:**

1. **Thinking is ON by default on Opus 5** (unlike Opus 4.8, where omitting the field meant no thinking), and `max_tokens` caps *thinking + response text together*. At `effort:"low"` thinking is short, so 4000 leaves plenty — but check `msg.stop_reason === "max_tokens"` and raise if the season report truncates.
2. **`msg.content[0].text` is `undefined`.** With thinking on and `display` defaulting to `"omitted"`, `content[0]` is a `thinking` block with empty text. Extract by type:
   ```js
   const text = msg.content.filter(b=>b.type==="text").map(b=>b.text).join("");
   ```
3. **`stop_reason === "refusal"`** returns HTTP 200 with empty content. Vanishingly unlikely for "write kind paragraphs about seven-year-olds playing soccer", but code that reads `content` unconditionally breaks:
   ```js
   if (msg.stop_reason === "refusal" || !text) return json({error:"report_failed"},502);
   ```
   **Not** proposing the `fallbacks` parameter (server-side refusal fallback). It's the SDK's recommended default and this is a conscious deviation: it adds a beta header and a parameter for a case that will not fire on this content, and the one-line guard already fails gracefully.

**No prompt caching.** One call per game, a system prompt well under the 512-token cache minimum. Explicitly not worth it.

**Plain text output, not structured outputs.** The deliverable is prose the coach pastes into a group text.

### System prompt (sketch, ~200 words)

AYSO Region 630 U8 · these are six- and seven-year-olds · one short warm paragraph per player, **every player gets one including players with no events** · reference something specific from the log where you can, otherwise their participation · never rank, compare, or imply anyone was better · never mention the score or winning · plain text, no markdown headers, ready to paste into a group text · close with a 3–4 sentence team recap · players are identified as PLAYER_1, PLAYER_2 … — use those labels **verbatim**, never invent one that wasn't given, and never write a bare `P1` (that means a quarter of play, not a child).

### Response

```json
{ "ok": true, "text": "…" }
```

### Error paths

| Situation | Worker | Client |
|---|---|---|
| Coach offline | — (`fetch` rejects) | `catch` → `toast("No signal — the report needs a connection. Your log is saved; try again from the car.")` |
| No secret deployed | 503 `no_api_key` | `toast("Reports aren't set up on this deployment.")` |
| Anthropic 5xx / 429 / timeout | 502 `report_failed` | `toast("Couldn't write the report — try again in a minute.")` |
| Doc too big / bad payload | 413 / 400 | toast the message |

**The event log is never touched by a failed report.** That's the offline-first contract: the log is local state, the report is a read-only derivation.

### Rate limiting

Required — the endpoint costs real money per call and the URL is public. Two things, both free:

1. **The team-token gate above.** This is the capability check, matching the app's existing model.
2. **A Cloudflare dashboard rate-limiting rule** on `/api/report*` — e.g. 10 req/min per IP. Zero code, zero state, and the zone is already on Cloudflare.

**Explicitly rejected:** any in-Worker counter. A D1 counter table violates the one-table constraint; KV adds a binding; an in-memory counter is per-isolate and therefore meaningless.

---

## 5. Privacy

The report call sends children's first names to a third party. Options:

| | Cost | Verdict |
|---|---|---|
| **A.** Send first names as-is | 0 lines | Requires a consent conversation with 8 sets of parents, plus a privacy note that will go stale |
| **B.** Pseudonymise client-side (`PLAYER_1`…`PLAYER_8`), substitute back on the response | ~12 lines | **Recommended** |
| **C.** Initials only ("N.", "B.") | ~2 lines | Worst of both — still identifying within a team of 8, and produces awkward prose |
| **D.** Don't ship the report | −everything | The fallback if the coach doesn't want any of this |

**Recommend B.** It doesn't *mitigate* the privacy question, it *removes* it — the Worker and the model never see a child's name. That makes the whole system smaller than "send names + write a privacy policy + get consent".

> **⚠️ REVIEW #3 (Major) — still open, and it is a data-model decision, not a line edit.** The aliases below are built from the *current* roster, but `state.games[].events[].player` holds ids of players who may since have been removed. After a `del-player` (:402) those ids aren't in `alias`, `JSON.stringify` drops the undefined key, and the Worker's `if (e.player && …)` guard sees a falsy value and **passes** — silent misattribution, with every later player shifted one alias down. Settle this before task 1: either archive the alias map alongside each game in `commitGame`, or keep a monotonic `state.aliasSeq` that only ever increments.

```js
// Names never leave the phone. The report comes back talking about PLAYER_3;
// we put Neel back in before the coach ever reads it.
var alias={}, real={};
state.roster.forEach(function(p,i){ alias[p.id]="PLAYER_"+(i+1); real["PLAYER_"+(i+1)]=p.name; });

// Longest first, so a roster with both Jeffrey and Jeff replaces Jeffrey first.
var order = state.roster.slice().sort(function(a,b){ return b.name.length-a.name.length; });

// escRe, NOT esc — esc() is already this file's HTML escaper (:44). A second
// function esc() in this IIFE would win and silently un-escape every render.
function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }   // a coach can type any name into #newName

// \b both ways: without it a player named Chase rewrites "great chase back on
// defence" and the model credits a child for a play they weren't in.
function scrub(s){
  order.forEach(function(p){ s=s.replace(new RegExp("\\b"+escRe(p.name)+"\\b","gi"), alias[p.id]); });
  return s;
}

// PLAYER_n, not Pn: the app already prints P1–P4 for periods (:194), so /P(\d+)/
// would rewrite a coach's "great save in P1" into "great save in Bearett".
// An alias the model invented has no name — leave the token visible so the coach
// catches it, rather than dropping it and shipping a sentence about nobody.
var out = data.text.replace(/PLAYER_(\d+)/g, function(m){ return real[m]||m; });
if(/PLAYER_\d+/.test(out)) toast("The report mentions a player I can't identify — read it closely.");
```

**Be honest about the limit.** Structured fields are airtight (and the Worker *enforces* it — §4). Free-text `note` events are verbatim coach speech and will contain names; `scrub()` catches whole-word case-insensitive matches but not nicknames ("Jeff" for "Jeffrey" is handled by the longest-first sort; "Zen" for "Zendrix" is not), and not recogniser misspellings. The `\b` anchors that stop it over-scrubbing also mean a possessive ("Neel's") still matches but a mangled transcription doesn't. Two honest options, pick one and write it in the README:

- Run `scrub()` over note text (recommended — same function, one more call, catches the common case), **and say in the README that it's best-effort**; or
- Don't send `note` events to the report at all. Airtight, and loses the most colourful material.

Also dropped from the payload for the same reason: timestamps (not in the model at all), the team name, and the score.

Not legal advice: COPPA generally addresses services *directed at children that collect data from children*; this is a coach's personal tool where the coach is the one entering data. Worth mentioning at the pre-season parent meeting the guide already requires — one sentence, not a form.

---

## 6. Testing

### Testable in `test/worker.test.mjs` (node --test, mock D1) — do all of these

The existing `makeD1()` mock handles `SELECT 1 FROM teams WHERE id = ?` as-is.

1. `GET /api/report/:id` → 405; bad id → 400; unknown team → 404
2. Missing `env.ANTHROPIC_API_KEY` → 503 `no_api_key`
3. Malformed JSON body → 400; `kind:"nonsense"` → 400; >64 KB body → 413
4. **`players:["Neel"]` → 400 `names_not_pseudonymised`** ← the privacy regression test, and the reason to enforce it in the Worker at all
5. A `games[].events[].player` of `"Neel"` → 400
6. Happy path with a stubbed network: assert the outbound body contains `"claude-opus-5"` and `"effort":"low"`, and that the returned `text` comes from the **text block**, not a leading thinking block (canned response: `content:[{type:"thinking",thinking:""},{type:"text",text:"…"}]` — this test is what catches the `content[0].text` trap)

For (6), stub `globalThis.fetch` in the test before the call — zero production code, since the SDK resolves fetch from the global. **Flag:** not certain this holds across all SDK versions; if the override doesn't take, pass `fetch` through the client options and inject via `env`.

### Not testable, verify by hand once

The **client-side pseudonymisation** lives in a DOM-coupled IIFE with no test harness. Do **not** build one — extracting a module + jsdom + a runner is a build step wearing a disguise. Instead: at `npm run dev`, log the payload in the Worker for one run, eyeball it, delete the log. The Worker-side `ALIAS` check is the permanent guard.

### Only verifiable by hand, on a phone, at a field

These decide whether the feature is real:

- **Does recognition work with no signal?** (airplane mode) — the make-or-break test
- Does `webkitSpeechRecognition` start at all in **standalone PWA mode** on iOS? (Add-to-Home-Screen)
- Recognition accuracy on the **actual eight names**: Bearett, Neel, Jeffrey, Oliver, Reyansh, Zendrix, Connor, George. "Zendrix" and "Reyansh" are near-certain to be mangled — this determines whether `alias` fields are needed
- Does `speechSynthesis` fight the period-end `beep()` (:354)? Does the TTS confirm abort the *next* `rec.start()` on iOS?
- Is the confirmation audible over field noise and parents?
- Does the Bluetooth shutter produce a `keydown` at all — and with what `key` / `code` / `keyCode`?
- Does the wake lock survive pocket → screen-off → re-focus?
- Battery cost of wake lock + mic over a 40-minute game
- One-handed operation while holding a clipboard

---

## 7. Ordered task list

### Step 0 — the smallest thing that proves the concept (1–2 h, throwaway)

A ~40-line temporary card in the Game Day panel. No data model, no Worker, no persistence. It:

- runs one push-to-talk recognition and prints the **raw transcript** and confidence on screen
- speaks the transcript back via `speechSynthesis`
- prints `e.key` / `e.code` / `e.keyCode` for **any** keydown, so pressing the Bluetooth shutter converts a guess into a fact

Then run it, in this order: (a) on the coach's actual phone in Safari/Chrome, (b) in the **standalone PWA**, (c) in **airplane mode**, (d) saying all eight real names, (e) with the shutter in both its iOS and Android modes.

Delete the card afterward. Everything downstream is contingent on what it reports — especially (c).

| # | Task | Effort |
|---|---|---|
| 1 | Data model + migration + lifecycle: `state.games`, `lu.events`, `migrate()` above the early return, `commitGame` archive, `g.date`, `adoptServer` → `migrate`, 413 branch in `push()` | 2 h |
| 2 | `logEvent` + `renderLog` + delete-a-row + the **tap-a-name/tap-a-verb chips**. Fully offline, fully useful, zero voice. This is the shippable floor | 3 h |
| 3 | `renderNudge` "hasn't scored yet" + `allEvents()`. Satisfies guide line 72; ~10 lines on top of task 2 | 30 m |
| 4 | Voice layer: `startListening`, `parseUtterance`, `speak`, PTT button state. Only as much as step 0 said will work | 3 h |
| 5 | Wake lock (`keepAwake`, wired into `toggleTimer` / `tick` / `visibilitychange`) | 45 m |
| 6 | Bluetooth shutter `keydown`, using the exact key value step 0 measured | 30 m |
| 7 | **Field test #1** — a real game with chips + voice. Nothing else is built until this happens | 1 game |
| 8 | Worker `POST /api/report/:id` + validation + `wrangler secret put ANTHROPIC_API_KEY` + system prompt | 3 h |
| 9 | Client `reportPayload` / `scrub` / `writeReport` + editable textarea + copy + button loading state (the call takes 10–30 s; the existing toast auto-hides at 1.9 s, so a disabled button with a "Writing…" label is required) | 2 h |
| 10 | Worker tests (the six above) | 1.5 h |
| 11 | **Field test #2** — game report at the car after the game, read every word before it reaches a parent | 1 game |
| 12 | Season report: `kind:"season"`, `max_tokens: 8000`, flatten `state.games`, prompt tuning | 1.5 h |
| 13 | README: voice log, `/api/report/:id`, secret setup, the pseudonymisation note and its honest limits | 45 m |

**~19 h plus two game days**, with a genuinely useful shippable product at task 3 (offline tap-logging + the guide-line-72 nudge) whether or not voice ever works.

### Cost

~2k in / 1.2k out per game report on `claude-opus-5` ≈ **$0.04 a game**, ~$0.40 for a season. Season report ~$0.15. Not a factor.

---

## 8. Things to verify, not trust

**High uncertainty, blocks the voice layer:**

- **Whether Web Speech recognition works offline on any target device.** Both Chrome (Google servers) and iOS Safari (Apple servers) appear to upload audio. Chrome 138+ has an on-device path (`SpeechRecognition.available()` / `installOnDevice()`) but it's Chrome-specific and adds real complexity. If offline recognition fails, the chip-tap path from task 2 is the product and voice is a bonus in the parking lot.
- **`webkitSpeechRecognition` inside a standalone iOS PWA.** Historically broken or unavailable in home-screen apps. The app *ships* with `apple-mobile-web-app-capable` and the README pitches Add-to-Home-Screen, so this is directly load-bearing.

**Medium uncertainty:**

- **iOS `speechSynthesis` needs a user-gesture unlock.** The confirm fires asynchronously after recognition — not in a gesture. Standard workaround: speak a zero-length utterance inside the PTT tap to unlock the queue.
- **Whether TTS and recognition can coexist on iOS** — the confirm may abort the next `rec.start()`, or vice versa.
- **Reusing one `SpeechRecognition` instance across presses** is reported flaky on Safari. Construct a fresh one per press — one extra line, sidesteps the class.
- **Bluetooth shutter key events.** These enumerate as HID keyboards; most send Volume Up in iOS mode and Enter/Return in Android mode. **On iOS, volume keys are consumed by the OS and are not delivered as `keydown` to a web page** — so the iOS-mode remote may simply not work in a browser. Step 0 measures this. Design so the on-screen button is primary and the remote is a bonus.
- **`@anthropic-ai/sdk` on workerd without `nodejs_compat`.** Recent versions are web-standard, but verify at `npm run dev` before deploying.
- **`globalThis.fetch` override** intercepting SDK requests in the node test. Fallback: pass `fetch` via client options.

**Low uncertainty but worth stating:**

- `navigator.wakeLock` needs HTTPS and a visible document, and **auto-releases on hide** — the `visibilitychange` re-acquire is mandatory. iOS Safari 16.4+.
- `max_tokens: 4000` at `effort: "low"` should fit eight paragraphs plus a recap with thinking on. If the season report truncates, the symptom is `stop_reason === "max_tokens"` — raise to 8000–16000.

---

## Adversarial review

Conducted 2026-08-03 against the source, not in the abstract. Line-number claims in the plan are almost all correct — the *behaviour* claims are where it breaks. Ranked most severe first.

### Blockers — both FIXED 2026-08-03

**#1 — `esc()` in §5 shadows the app's HTML escaper, disabling all output escaping.** ✅ **FIXED** — renamed to `escRe` in §5.
§5 declares `function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }` inside the same IIFE that already defines `esc()` as the HTML escaper at `app.js:44`. Duplicate `function` declarations in one scope are legal — last one wins, no error. All 17 call sites (`renderRoster` :64, `renderLineup` :206, `slackNote` :246, `renderOnField` :373/382/390, `renderDrills` :300-304, …) start regex-escaping instead of HTML-escaping. A player named `<img onerror=…>` renders live. The plan's own "no new script file" decision (§3) is what puts both declarations in one scope.
**Fix:** rename to `escRe`. One word.

**#2 — "`buildLineup(replace=true)` mutates `lu` in place, so `lu.events` survives" is false before kickoff.** ✅ **FIXED** — §1 now carries events across the fresh-literal branch; the §2 audit table splits the mid-game and pre-kickoff cases.
`app.js:108` `var keep = replace ? frozenUpto() : 0;` → `:123` `var lu = keep ? state.lineup : {…};`. `frozenUpto()` (:96-101) returns 0 unless `g.started || g.period>1 || g.us || g.them`. So while the game is 0–0 in period 1, **every** path through `refreshLineup()` → `buildLineup(_,true)` — `toggle-present` (:403), `del-player` (:402), `addPlayer` (:434), `syncSettings` (:441), ↻ Reshuffle (:405) — creates a fresh literal and discards the log. Marking a late arrival IN loses your warmup notes. This is version-independent; it breaks in the new code. The §2 audit-table row asserting survival is wrong for the same reason.
**Fix:** `events:(replace&&state.lineup&&state.lineup.events)||[]` in the literal.

### Majors

**#3 — Roster-index aliases break archived events when a player leaves mid-season.**
`alias[p.id]="P"+(i+1)` is built from the *current* roster, but `state.games[].events[].player` holds ids of departed players. `del-player` (:402) filters the roster; those ids vanish from `alias`, every later player shifts one alias down, `JSON.stringify` omits the undefined key, and the Worker's guard `if (e.player && !ALIAS.test(e.player))` sees a falsy value and **passes**. Silent misattribution, not a caught error. `state.played` also retains the departed id, yielding an `"undefined"` key in `periods` — which the Worker doesn't validate at all.
**Fix:** store aliases with the archived game at `commitGame` time, or use a monotonic `state.aliasSeq`. Validate `periods` keys server-side too.

**#4 — §1's caps do not bound §4's 64 KB payload; a heavy season permanently breaks the season report.**
Minimal pseudonymised event `{"player":"P3","kind":"goal","period":2}` = 40 chars + separator = 41 B. The caps allow 12 games × 150 events = 1,800 × 41 = **73,800 B > 65,536**. With notes (149 B each) it's far worse. **The #6 fix makes this worse, not better:** `PLAYER_3` is 6 chars longer, so the same event is 47 B and the worst case rises to **84,600 B**. Trading 19 KB of headroom to stop the report calling a child by a quarter number is the right trade, but it moves this finding from "will bite eventually" to "will bite". §1's *doc* budget is fine (12 × 150 × 155 = 279 KB < 512 KB — that arithmetic checks out); §4's cap is independent and tighter. The client's only handling is a toast, with no path back to a working report.
**Fix:** build the season payload newest-first and stop at 60 KB; say in the toast that older games were omitted.

**#5 — "The loss window is exactly one action" — there are at least four.**
The round-trip-safety argument holds only for a device that *adopted* the new doc.
- `app.js:521-528`: on 409, `keepMine` → `push(true)` overwrites the server with this device's whole `state`. A stale device has no `games` key — server-side history destroyed. `pull()` at :546 (`if(isDirty()) return push();`) guarantees a dirty stale device never adopts first; it always races into the conflict dialog. The §2 row "Anything touching `state.games` — Nothing does. **Always survives**" is wrong.
- `app.js:116` `else if(state.lineup){ state.lineup=null; }` fires on `buildLineup(false,false)` when fewer than `onfield` are present, so `commitGame` at :122 is never reached — the **entire outgoing game's** events *and* its unbanked minutes are destroyed. §2 calls this "pre-game events lost (narrow)". It isn't.
- Plus #2, which is version-independent.
**Fix:** hoist `commitGame` above the short-handed guard at :110; either union-merge `games` on the 409 path (it *is* append-only) or reword the conflict dialog to name what's lost.

**#6 — `/P(\d+)/g` collides with the app's own period labels.** ✅ **FIXED** — `PLAYER_n` tokens throughout §4 and §5, payload field renamed `periods` → `quartersPlayed`, unresolved-token assertion added, system prompt updated.
`app.js:194` renders period headers `P1`–`P4`. §4's payload sends both `period: 2` and a field named `periods` keyed `{"P1":3.5}` where `P1` means a *player*. A coach's note "great save in P1" is sent verbatim, echoed by the model, and rewritten into "great save in Bearett". No guard for a hallucinated `P9` either (`real["P9"]` undefined → literal `P9` reaches a parent).
**Fix:** `PLAYER_1`…`PLAYER_n` with `/PLAYER_(\d+)/g`; rename the payload field to `quartersPlayed`; assert `!/PLAYER_\d+/.test(out)` before display.

**#7 — The proposed `adoptServer` one-liner runs `migrate()` before the `played`/`kept` guards.**
`app.js:552-557` is `state=incoming;` then `if(!state.played) state.played={};` then `if(!state.kept)…`. `migrate`'s body (:32) does `s.played[id]=(s.played[id]||0)-1` — a TypeError on exactly the pre-migration shape `migrate` exists to handle.
**Fix:** insert `migrate(state);` after :557, not at :555.

**#8 — `state.games` capped at 12 while `state.played`/`state.kept` are uncapped career totals → confidently-wrong reports.**
`commitGame` (:89-93) accumulates the ledger forever; nothing resets it (no reset path exists in `app.js`). §4 describes `periods` as "this season", but `totPlayed()` returns career. Cross a season boundary and the report claims 68 quarters against 12 archived games; drop game 13 and its goals vanish while the minutes remain. There is no UI to end a season, so this is the default trajectory.
**Fix:** derive `periods` from `state.games` + the live lineup — same source as `events`, so the two always agree. Separately, a season boundary needs *some* answer before this ships.

**#9 — `"@anthropic-ai/sdk": "^0.6x"` is not valid semver, and 0.6.x predates everything the plan calls.**
`package.json` has no `dependencies` block today; this is the project's first runtime dep. `output_config`, `claude-opus-5` typings, and the current `content` block unions all postdate 0.6.x.
**Fix:** pin whatever `npm view @anthropic-ai/sdk version` returns; make "install + `npm run dev` + confirm no `node:` builtin error" an explicit sub-step of task 8, not a footnote.

**#10 — `parseUtterance` mis-parses the three most natural things a coach shouts.**
Both loops are last-match-wins. `VERBS` key order puts commendation words last, so `"great save"` → commendation, `"nice shot"` → commendation, `"good goal"` → commendation. The roster loop takes the last match in *roster order*, so `"Neel to George"` credits George. No `p.present` filter. The `" "+s+" "` padding is dead code — nothing checks word boundaries, so `goal` matches "goalie" and `save` matches "saved".
**Fix:** verbs longest-first with `break` (or check commendation words only if no action verb matched); first roster match by `t.indexOf(name)` minimum.

**#11 — The rate-limiting plan doesn't apply to the deployment the README actually produces.**
WAF rate-limiting rules are zone-scoped and do not apply to `*.workers.dev`. `README.md:15-29` deploys to workers.dev with the custom domain as an explicit *optional* follow-up, and `wrangler.jsonc:30` has `routes` commented out. On the default deployment, protection #2 of the two named doesn't exist — leaving the team token, which the coach texts around, as the only gate on a paid endpoint.
**Fix:** make the custom domain a prerequisite for the report feature, or accept the token-only gate and say so plainly. (Rejecting an in-Worker counter was correct.)

### Minors and nits

**#12** ✅ **FIXED** — `scrub()` over-scrubbed as well as under-scrubbed: no word boundary, so a player named Chase turned "great chase back on defence" into "great P4 back on defence" and the model credited the wrong child. `\b` anchors added, longest-first ordering kept.

**#13** Four of the six Worker tests can't reach their assertions — `test/worker.test.mjs:30` `env()` has no `ANTHROPIC_API_KEY`, and the D1 mock starts empty, so tests 3–6 short-circuit on 503/404. (The plan's claim that `makeD1()` handles `SELECT 1` as-is is *true* — `first()` at :16 returns by id regardless of SQL text. The gap is seeding.) Fix: seed with a `PUT` first, extend `env()` with a fake key.

**#14** "sw.js revalidates the shell on every launch" holds only for *online* launches, and the revalidation isn't kept alive. `sw.js:33-39` returns `hit || fresh` with `fresh` as a floating promise — no `e.waitUntil(fresh)`, so the SW may be killed before `cache.put` lands; and `.catch(() => hit)` means an offline launch never updates. The §2 mitigation ("open the app once on the assistant's phone") only works with signal. Whether the browser HTTP cache sits in front of the SW's own `fetch()` is **unverified**. Fix: add `e.waitUntil(fresh)`; reword to "open the app once **on wifi**".

**#15** Wake-lock re-acquire is wired into a listener that doesn't exist in local-only mode — `app.js:583` returns before the `visibilitychange` registration at :605, and the README explicitly supports the no-backend mode. Also `resetTimer()` (:458) and `nextPeriod()` (:459-467) set `g.running=false` without releasing the lock. Fix: register a top-level listener; drive the lock from one `setRunning()` helper.

**#16** Newest-first `renderLog()` + `data-i` + `splice` deletes the wrong event — every existing `data-i` handler (`rm-drill` :408, `mv` :409, `set-mins` :423) operates in storage order. Fix: emit the original index, or splice by identity.

**#17** *(Nit)* `g.date=nowMs()` at :148 records when the sheet was *built*, not played — wrong day for a coach who preps the night before. Fix: set it in `toggleTimer()` beside `g.started=true`, guarded.

**#18** Scope, both directions. Over-built: `state.games[].us`/`.them`/`.date` are archived in §1 then explicitly dropped from the payload in §4, and nothing else reads them. Under-built: §4's "`BACKEND && TEAM` are always both set" is false when `detectBackend()` returns false (:583, the documented Artifact/`file://` mode) — `TEAM` can be `null` and `/api/report/null` 400s, with no gate hiding `#reportTools`; and §4's snippet uses a bare `db`, but the binding resolution lives inside the `/api/team/:id` block at `worker.js:38`.

**#19** Effort is ~20 h, not ~19 h (table sums to 18.5 h; step 0 is listed separately at 1–2 h). Task 8 (3 h) bundles the first runtime dependency, an unresolved `nodejs_compat` question, first-time `wrangler secret put`, *and* authoring a system prompt that must produce eight non-comparative paragraphs about seven-year-olds — prompt iteration alone eats that. Task 10 (1.5 h) rests on a mechanism the plan itself flags as unverified. Task 12 inherits #3 and #4. Revised: 8 → 5 h, 10 → 2.5 h, 12 → 3 h, **~25 h plus two game days**. The "stop early at task 3" claim **does** hold — tasks 1–3 are self-contained.

### What the plan gets right

- **Line-number accuracy.** Every cited line checked out: `commitGame` at :122 does run before the :148 score reset; `migrate`'s early return at :29 is real and appending to the body would be a no-op; `adoptServer` genuinely never calls `migrate`; `push()` at :530 genuinely converts a 413 into a permanent "Offline — will sync" plus a 15 s retry loop.
- **The Anthropic API facts are correct** — thinking on by default on Opus 5 (unlike 4.8), `max_tokens` covering thinking + output, `effort` inside `output_config`, `content[0]` being an empty thinking block under the default `display:"omitted"`, extracting by `b.type==="text"`, the refusal-on-HTTP-200 guard, the 512-token cache minimum, TS-SDK timeout in ms. Cost arithmetic checks out — **though thinking tokens bill as output, so roughly double it: ~$0.08/game, ~$0.80/season.** Still not a factor.
- **"No new script file" is right.** `sw.js:8` `SHELL` lists all three script tags; adding zero tags means zero SW plumbing.
- **The Worker-side `ALIAS` boundary check is the correct instinct** — enforce the privacy property where it's testable rather than trusting a DOM-coupled IIFE.

### The single thing most likely to sink this feature

**Silent, cheap event loss on routine actions** (#2, #5, #3). The coach's contract with a voice log is "say it and forget it" — the whole pitch in §0 is *put the phone back in your pocket*. But marking a late arrival present before kickoff wipes the log, a short-handed Saturday wipes the previous game's log, and a kid quitting the team erases their goals from the season report. None of these throw, none toast, and all are invisible until the coach reads a report missing what they remember calling out. One wrong report about somebody's child is enough to stop trusting the feature permanently — and unlike a crash, they'll never know which events went missing, so they can't re-enter them.

---

## Verdict

The shape is right; the details need a pass. Recommended sequence:

1. **Step 0 first** — the airplane-mode test decides whether the voice layer exists at all, and it costs 1–2 h.
2. ~~Fix #1 and #2 before writing any feature code.~~ ✅ Done 2026-08-03, along with #6 and #12.
3. **Settle #3 (alias stability) and #8 (season boundary) before task 1** — data-model decisions; retrofitting either means rewriting archived data. #4 (payload cap) now needs an answer at task 12 rather than "eventually".
4. Treat tasks 1–3 as the actual deliverable. Offline tap-logging plus the guide-line-72 nudge is a real feature that ships whether or not voice or the LLM report ever work.

### Still open

| # | Severity | What | Blocks |
|---|---|---|---|
| #3 | Major | Alias instability when a player leaves mid-season | task 1 (data model) |
| #8 | Major | `state.games` capped at 12 vs uncapped career ledger; no season boundary | task 1 (data model) |
| #4 | Major | 64 KB payload cap < worst-case season (now 84.6 KB) | task 12 |
| #5 | Major | Event loss on the 409 force path and the short-handed branch | task 1 |
| #7 | Major | `migrate()` must go *after* the `played`/`kept` guards in `adoptServer` | task 1 |
| #9 | Major | Invalid SDK version spec; `nodejs_compat` unresolved | task 8 |
| #10 | Major | `parseUtterance` last-match-wins — "great save" logs as a commendation | task 4 |
| #11 | Major | WAF rate limiting doesn't apply to `*.workers.dev` | task 8 |
| #13–#19 | Minor/Nit | Test seeding, `sw.js` `waitUntil`, wake-lock wiring, log delete index, `g.date` timing, scope, estimates | various |

**Not fixed here, and not part of this feature:** #7, #14, and the short-handed half of #5 are latent bugs in *shipped* code — `adoptServer()` skips `migrate()` today, `sw.js` drops its revalidation promise today, and a short-handed Saturday already destroys the outgoing game's unbanked minutes today. They're worth fixing on their own merits, independent of whether this feature is ever built.
