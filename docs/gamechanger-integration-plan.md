# GameChanger & League Platform Integration — Findings and Plan

**Status:** research complete, adversarially reviewed 2026-08-05. Plan amended.
**Verdict: build no integration. Build `copyRecap()` instead.**

The original research reached the right conclusion (don't integrate) via two wrong facts and one
false premise. This doc records the corrected findings so nobody re-runs this research.

---

## Corrections to earlier claims

| Earlier claim | Verdict | Correct version |
|---|---|---|
| "GameChanger has no write API" | **wrong framing** | No *public* API. Private write endpoints exist on `api.team-manager.gc.com` and are live. |
| "Login is an emailed one-time code" | **false** | `POST /auth {email, password}` → JWT. A token is obtainable programmatically. |
| "Only write path is Sports Connect org import" | **false** | GC has org-admin CSV bulk schedule import needing no Sports Connect, plus team-level roster+schedule import by any allocated volunteer. |
| "Connect Compete is the only sanctioned scoring write" | **false** | Plain Sports Connect team sites have native score entry (Calendar → Results). |
| "Peer orgs are cutting over to PlayMetrics Fall 2026-27" | **overstated** | AYSO region cutover is opt-in and staggered. Some regions are still on Sports Connect for 2026/27. |
| "Avoid API 37 / Android 17 AVDs" | **stale** | The GMSCore login bug is real and correctly dated (2026-06-16) but fixed in rev 5+. |
| "Windows can't run Android, no replacement for WSA" | **half wrong** | Google Play Games on PC went GA Sept 2025 (games only). And the Android Studio emulator runs Android on Windows fine — that was always the answer. |

### What held up

- **Scores cannot be written to GameChanger by any documented means.** Every import schema is
  date/time/teams/location/duration. GC states plainly that games scored in GameChanger do not
  flow back to Sports Connect either.
- **Soccer scorekeeping is mobile-only.** web.gc.com's post-game stat editing is scoped to
  baseball/softball. No soccer web write path.
- **AYSO → PlayMetrics is real** — AYSO National announcement, Sports Connect and the Association
  Platform sunset in **2027**, MY26 pilot was region opt-in. PlayMetrics and Stack Sports did
  combine (Genstar, June 2025). Region 630's timing is unknown — ask the RC.
- **The GC calendar/ICS feed is real** — mobile app → team → gear → Schedule Sync. Plain HTTP,
  unauthenticated, pollable. Pull with a **Staff**-tier account or practices are silently omitted.

---

## The private API (for the record — not a recommendation)

Established by method-aware probing (`404` = no handler for that method+path, `401` = handler
exists, authenticate):

```
POST  /teams/{uuid}/players   -> 401   # write handler exists
PATCH /players/{uuid}         -> 401   # write handler exists
PATCH /teams/{uuid}           -> 401   # write handler exists
Access-Control-Allow-Methods: GET,HEAD,PUT,POST,DELETE,PATCH   (origin https://web.gc.com)
```

Auth is `gc-token` (JWT) plus `gc-client-id` (hardcoded UUID), `gc-device-id` (client-generated,
unverified), and an HMAC-SHA256 `gc-signature` keyed by a symmetric secret shipped in the public
web bundle. **The backend does not and cannot enforce Play Integrity** — web.gc.com is a
first-class client that couldn't produce an attestation token, and non-browser clients with
fabricated device ids are accepted on production endpoints.

**No score-write endpoint has been found.** Guessed paths (`/games/{id}/score`, `/box-scores/{id}`,
`/game-summaries/{id}`, …) all 404. The scoring surface is **unmapped, not proven absent** — and
it likely lives on the mobile client surface, which nobody has captured.

If scores in GC ever become worth it, the 10-minute first step is: open devtools on web.gc.com,
edit a stat on your own team, read the request off the network tab. Not a scraping rig. Note this
is undocumented surface with no stability contract, and using it is a ToS question.

Reference implementation if it's ever revisited: `sportsmockery/LevelUp` → `scripts/gamechanger/auth.py`
is a complete port of the signing algorithm, credited to `web.gc.com/assets/gamechanger-auth-*.js`.
~17–22 GitHub repos query this host with ordinary HTTP clients. **Caution:** WebSearch repeatedly
surfaces `TheAlanNix/gamechanger-client` with a detailed description — that repo returns 404 and is
absent from the user's repo list. Deleted or fabricated; don't cite it.

### Evidence gaps in this research

Recorded so the confidence level is legible: web.archive.org, stackoverflow, reddit, and xdaforums
all refused the research fetchers, and issuetracker.google.com needs sign-in. The GC APK SDK
inventory could not be obtained, so whether the *client* bundles Play Integrity is unknown (the
backend demonstrably doesn't enforce it, which is the part that matters). No genuine user report
exists of GameChanger working or failing on an emulator — every "GameChanger on PC" page is
BlueStacks/MEmu SEO spam and is worthless as evidence.

---

## Why UI automation is dead (the real reason)

Not "it's absurd for U8" — that was hand-waving. The actual blockers:

1. **GameChanger has no "final score" field.** Score is *derived* from scored events. Entering a
   score means tapping a goal per team, assigning scorer/assist, advancing periods, finalizing.
2. **Finalizing is near-irreversible.** Box-score edits do not propagate to plays or Recap Stories.
   A queue-and-drain rig replaying intents into a finalized game produces silently divergent state.
3. **Blast radius.** A mis-tap publishes a wrong score or credits *someone else's kid* with a goal,
   into the feed ten families are watching. The GC account is the coach's identity in the region —
   a ban costs the team its schedule and its chat.
4. **GC ships every 1–2 weeks** (10 releases Apr–Jul 2026) and raised minSdk mid-season. Selector
   drift is a certainty, not a risk.
5. **Scoring is a single-device authoritative role** — GC instructs one device/account per game. A
   robot scoring in parallel with the human scorekeeper is a conflict, not a merge.

Do not sell this as a "reusable pattern." The transferable lesson is the inverse: **don't drive a
UI you don't own against a system other people depend on.**

### Android-on-Windows facts (if this ever comes up on another project)

- WSA: end of support 2025-03-05, Store discovery ended 2024-03-06. Dead, no revival.
- Android Studio emulator via WHPX is the answer. AEHD sunsets 2026-12-31 — use WHPX.
- Use `system-images;android-36;google_apis_playstore;x86_64`. Maestro's driver targets SDK 36;
  37 is ahead of it. GameChanger's floor is API 30 as of v2026.28.0.1 (2026-07-23).
- GameChanger Android package: **`com.gc.teammanager`**.
- Play-signed images can't be rooted. That's fine — no root needed.
- No Android SDK is installed on this machine (`ANDROID_HOME` unset, no `adb`).
- Maestro has an **open** bug ([#3414](https://github.com/mobile-dev-inc/Maestro/issues/3414),
  updated 2026-07-17) on exactly Windows 11 + physical device over adb; 2.5.1 works, 2.6.x doesn't.
- iOS from Windows: Maestro is simulator-only and Appium real-device needs a Mac — **but this is the
  one claim in this doc that was never adversarially verified** (the reviewer was stopped before it
  returned). Unanswered: whether a cloud device farm (BrowserStack / Sauce / AWS Device Farm) would
  sidestep the Mac requirement for a third-party App Store app you didn't build. Treat as
  provisional. Doesn't change the decision — automation is dead for the product reasons above.
- Maestro now ships a native Windows installer (`MaestroStudio.exe`) — the "Windows needs WSL"
  advice you'll find in older posts is stale.

### Play Integrity on an emulator (documented inference, not measurement)

Relevant to other projects, not this one — **GameChanger's backend doesn't check, so the emulator
path would work here.** But for any app that *does* check:

- `MEETS_DEVICE_INTEGRITY` was rewritten (~May 2025) from a behavioral test to a hardware one:
  *"genuine and certified Android device… hardware-backed proof that the bootloader is locked."*
  A stock `google_apis_playstore` AVD cannot satisfy that.
- `MEETS_VIRTUAL_INTEGRITY` is **not** a general emulator pass — it's fenced to apps shipping on
  Google Play Games on PC.
- Expected result for a stock AVD post-May-2025 is a **blank** `deviceRecognitionVerdict`.
  This is inference from current docs; nobody has published an actual measured verdict from such
  an AVD since the rollout, and the archived pre-2025 wording could not be retrieved to confirm
  the change. Whether `MEETS_BASIC_INTEGRITY` still appears is genuinely undetermined.

---

## The actual opportunity we missed

**coach-app is the only system in the region that knows whether a kid played enough.**

`appearances(game_id, player_id, period, pos, frac)` and `GET /api/team/:id/positions` already
compute per-kid, per-quarter, per-position history. That answers the two things U8 rec parents
actually raise with coaches, and the two things the region's own rules mandate:

- every player plays 3 of 4 quarters before anyone plays 4
- goalkeeper max 1 quarter per player

GameChanger will never know any of that. The score — the thing we spent the whole research on — is
the one number the region says doesn't count, and a designated scorekeeper is already publishing it
live. We optimized the redundant payload and ignored the unique one.

---

## Amended plan

### Build

**P0 — `copyRecap()`.** One tap, plain text to clipboard, per-kid: quarters played, position mix,
keeper quarter, goals/assists. No score line. Data and output paths already exist (`getStats`,
appearances, the existing clipboard helper). Goes into GC team chat, group text, WhatsApp, or email
identically because it's plain text. **~1 hour.** This also serves the region's #1 coaching reminder
("communicate often with parents") and doubles as the blowout-management tool the guide describes —
"we worked on passing in Q4" reads very differently than 8-0.

**P1 — read-only share, only if a parent asks.** Currently blocked: the team id *is* the write
credential (`schema.sql:7`), and the optional passphrase (`gate()` in `src/worker.js`) is
all-or-nothing — set it and parents see nothing, leave it off and anyone with the link can reorder
the lineup or delete a player. Needs a separate `view_token`, a `GET /api/team/:id/public` returning
only names + appearances + games, and a `/v/<token>` read-only route. **~half a day.**

Parents will not install the coach's PWA. Text goes where they already are; the link is for the one
parent per season who wants detail.

### Don't build

- **ICS schedule pull** — killed. Premise was false: coach-app has no schedule feature at all
  (`opponent: null` hard-coded, no date field, no next-game concept). There is no double entry to
  eliminate. Building it means building a schedule feature first, to save typing ~10 rows currently
  typed zero times. If the coach wants the schedule on his phone, he subscribes to the ICS in his
  phone's calendar app — native, free, handles reschedules, zero code.
- **Any UI automation rig.** See above.
- **Sports Connect / Stack Team App / Connect Compete integration** — dying platform, and none of
  them publishes a public API anyway.
- **GC roster → coach-app pull.** Roster is 8 names with ~1 add/drop per season, and GC has no read
  API either. More clicks than typing eight first names once.

### Ask a human

- Region 630's RC or registrar: does MY27 registration run on Sports Connect or PlayMetrics?
  Don't hard-code either as the backend.

---

## Why not push the score (corrected reasoning)

Not "the region doesn't officially keep score" — that's a rulebook technicality used to overrule a
real goal, and parents and kids obviously track it. The honest reasons:

1. There is no documented write path for scores, and the undocumented one is unmapped.
2. GameChanger's value to parents is the **live** feed during the game. A post-hoc push can't
   reproduce that.
3. A designated scorekeeper is already staffed and already producing it. Pushing would duplicate a
   volunteer job that's done.

coach-app's score is a private coaching input (it drives the blowout nudge), not a published fact.
Avoid framing it as "sideline truth" — inventing a second authoritative score in a league that
deliberately has none creates a dispute the coach then owns.
