# Codex handoff — second-opinion review of Coach's Sideline

Copy everything below the line into Codex, run from the repo root.

---

You are giving a second-opinion product + domain review of **Coach's Sideline**, a U8 AYSO soccer coaching app (roster/lineup, practice builder, drill library, game-day dashboard, season stats). It is a local-first single-page app (vanilla JS, no framework, no build step) synced through a Cloudflare Worker + D1. Another AI built and reviewed it; your job is an independent critique, not a rubber stamp. **Read-only review — do not modify any files.**

## Context to read first (in this order)

1. `README.md` — architecture, sync model, auth, API surface.
2. `docs/Fall 2026 - Guide for Coaching U8.md` — the actual AYSO Region 630 U8 rules/guide the app must serve. Treat this as ground truth for domain questions.
3. `docs/coaching-guide-audit.md` — a prior audit of the app against that guide. Verify its claims rather than trusting them.
4. `docs/infrastructure-audit.md` + `docs/infrastructure-fixes-handoff.md` — a completed infra/security audit with an adversarial pass. **Do not re-audit infrastructure.** Read it so you don't duplicate it, and so you can challenge it (see §11).
5. `public/index.html` — full UI structure (single file app shell).
6. `public/app.js` — all app logic (~2,750 lines / ~43k tokens; skim by section, deep-read game-day and stats flows).
7. `public/lineup-core.js`, `public/stats.js`, `public/state.js` — lineup rotation math, stat rollups, persisted state shape.
8. `public/sw.js`, `public/outbox.js` — offline shell cache and write queue (relevant to §6).
9. `public/drills.js` — drill library content (relevant to §8).
10. `src/worker.js` — API, auth, GameChanger ICS schedule proxy.
11. `test/` — 12 files, 115 tests (lineup, played-time, stats, season, state, outbox, archive, worker, auth, credit, schedule, iv).

Ignore `.wrangler/` and `.wolf/` (tooling/state, not product). `docs/handoffs/` and the various `*-plan.md` / `*-prompt.md` files are historical — read only if §12 sends you there.

## Domain facts to review against (U8 AYSO, Region 630)

- 5v5 (4 field + no dedicated keeper at U8 in many regions — **verify what the guide in docs/ says and judge against that, not generic assumptions**), quarters not halves, everyone plays ≥50%, no standings/scores emphasized at this age, substitutions at quarter breaks, small roster (~8-10 kids).
- The app's core promise: fair playing-time rotation, position variety, and a sideline-usable game-day screen with no signal.

## The user this app serves

Assume the median user is a **volunteer parent coach**: no soccer background, coaching for one season, using a phone one-handed, outdoors, possibly in rain or glare, while eight 7-year-olds need attention. They will not read documentation, will not configure anything, and will abandon a screen that takes more than a few seconds to understand. Judge every finding against that person, not against a power user. Where a feature only makes sense for a more invested coach, say so.

## Questions to answer

### 1. Game/flow fidelity
Walk the app's game-day flow end to end (pre-game lineup → quarter-by-quarter → subs → post-game). Where does it diverge from how an AYSO U8 game actually runs, per the guide? Where does it diverge from soccer generally (clock handling, stoppage, quarter length, subs mid-quarter for injury, late-arriving/absent kids)? Flag anything that would force a coach to fight the app mid-game.

### 2. Metrics audit
List every metric the app computes/reports (see `stats.js`, season stats in `app.js`, `lineup-core.js` played-time math). For each: (a) is it **useful** to a U8 rec coach, (b) is it **true** — check the math and edge cases (partial quarters, kid leaves injured, forfeits, data entered late), (c) what's **missing** that this audience would actually want (e.g. position-variety over the season, fair-play % per kid, development notes). Call out any metric that's actively wrong or misleading. Also flag metrics that exist but *shouldn't* (score-keeping pressure at an age level where AYSO de-emphasizes it).

### 3. Weakest aspects
Rank the 5 weakest aspects of the app overall — product, UX, code, or infrastructure — with one-paragraph justification each and the single highest-leverage fix for each. Be blunt.

### 4. Competitive analysis
Brief landscape scan of comparable apps: GameChanger, TeamSnap, Heja, SportsEngine, Coach's Eye-style tools, and any youth-soccer-specific lineup/rotation apps (e.g. Playing Time Pro, Soccer Lineup builders). For each: what they do better, what Coach's Sideline does better, and whether the niche (volunteer U8 rec coach, offline sideline use, fair-play rotation) is actually underserved. Keep it to a table + a few paragraphs. Web search if available; otherwise reason from known products and say so.

### 5. Offline & data-durability reality check
"Works on the sideline with no signal" is the core promise — stress-test it in code, not in theory. Trace: `sw.js` shell cache, `outbox.js` queue, `state.js` persistence, and the `rev`/conflict path in `worker.js`.
- What is the actual failure mode when the app is opened cold with **no** connectivity? When connectivity is *flaky* rather than absent (the real sideline case — LTE that half-works)?
- Where can a coach **lose data**? Enumerate concrete loss paths: localStorage quota/eviction, iOS Safari 7-day storage eviction for non-installed PWAs, private browsing, a mid-game tab crash, two devices (coach's phone + assistant's) editing the same game.
- Is anything critical held only in memory and lost on a background-tab kill mid-quarter?
- Is the sync model actually last-write-wins in practice, whatever the `rev` field implies? What does a coach *see* when a conflict happens?
- Rank these by (likelihood × pain) for one real season, and say which are worth fixing versus documenting.

### 6. Sideline ergonomics & accessibility
Judge `index.html` + `app.css` against use in bright sun, with cold or wet hands, one-handed, while not looking at the screen for more than a second.
- Tap-target sizes on the game-day screen, contrast ratios (WCAG AA minimum — check actual color values), font sizes at arm's length, and whether critical actions sit in thumb reach.
- Destructive/irreversible actions: is anything one mis-tap away from wrecking a game record? Is there undo?
- Does the screen stay awake? Does it survive rotation, an incoming call, backgrounding?
- Baseline a11y: keyboard reachability, focus states, labels on controls, screen-reader sanity for the roster and lineup grids.
- Call out anything that only works because the developer knows where to tap.

### 7. Season lifecycle & data hygiene
The app is used across a whole season and then, ideally, a next one.
- Roster churn mid-season (kid quits, kid joins in week 4, sibling added, name changes) — does the stats math survive it, or do historical rollups break/silently misattribute?
- Rollover to the next season, and to a second team: is it possible without hand-editing state? (Note `docs/infrastructure-audit.md` F2 — the schedule feed is single-tenant.)
- Export/portability: can a coach get their data out in a form a human or a spreadsheet can use? What happens at end of season — is there a delete path?
- **Kids' data**: names, photos (if any), schedules, whereabouts. What is stored, where, for how long, and who can reach it? Judge against what a parent would reasonably expect and against COPPA-adjacent norms — this is a product/consent question, not the infra question already answered in the infra audit.

### 8. Practice builder & drill library — content quality
This is content, not code, and content is where a coaching app is actually judged.
- Are the drills in `drills.js` age-appropriate for 6-8 year-olds per the guide (attention span, touches-per-minute, no elimination games, no lines)? Cite the guide.
- Does the practice builder produce a session a novice coach could actually run — right total duration, sensible warm-up→activity→scrimmage arc, equipment a volunteer has?
- What's the coverage gap versus the guide's recommended skill progression across a season?
- Is there enough content to survive a 10-week season without repeating, and does that matter?
- Add additional content, or find free resources online to integrate  

### 9. First-run & onboarding
A volunteer opens the link 10 minutes before the first practice, with a roster on a crumpled printout.
- Time-to-first-value: how many taps from cold open to a usable lineup? Where does it stall?
- Is roster entry tolerable on a phone for 10 kids? Any paste/import path?
- What is unexplained but essential (the capability-link model, what syncs, what "quarters" assumes)?
- Where would this coach silently give up and go back to a paper grid or a notes app? Be specific about the screen.

### 10. Test-suite quality (not coverage %)
115 tests pass. Judge whether they're worth their upkeep.
- Which tests assert real behavior versus restating the implementation? Name the weak ones.
- What critical path is **untested**? Specifically look at: the game-day state machine, the outbox flush/retry ordering, conflict resolution, and season rollups across roster changes.
- Are there tests that would still pass if the feature were broken in the way a coach would actually notice?
- Recommend the smallest set of new tests with the highest defect-catching value. Don't propose a testing framework migration.

### 11. Architecture & the prior audit
- `app.js` is ~2,750 lines in one file with no build step. Is that a real problem or an acceptable trade for this app's size and its zero-build deploy story? Give an honest verdict, and if you say split it, say the seams and what breaks (service-worker cache versioning, script load order, global state).
- Identify dead code, duplicated logic between `app.js` and the `*-core`/`stats` modules, and anywhere the DOM is the source of truth instead of state.
- **Challenge `docs/infrastructure-audit.md`**: pick any findings you believe are wrong, mis-severitied, or missing, and say why with `file:line` evidence. Where you agree, say so in one line and move on. Do **not** produce a fresh infrastructure audit.

### 12. Open recommendations
Anything else: features worth adding, features worth **deleting** (be aggressive — an unused feature is a maintenance tax and a UI distraction), risks, and stale plans. `docs/` contains several forward-looking plan documents (`gamechanger-integration-plan.md`, `voice-game-log-plan.md`, `game-day-ui-plan.md`, `azure-research.md`, `firebase-research.md`) — say which are still worth doing, which are dead, and which conflict with the app's local-first/no-build architecture.

## Constraints on your recommendations

- This is a solo-maintained, one-team, zero-budget app with no build step. Recommendations must respect that: no framework migrations, no CI platforms, no new runtime dependencies unless you argue the case explicitly.
- Prefer the smallest change that closes the gap. If your fix is longer than the problem, say what the lazy version is too.
- Every fix gets a rough size (`~lines` or S/M/L) and a "what breaks if we do this" line.

## Output format

One markdown report, sections 1-12 above. Lead each section with a 1-2 sentence verdict, then evidence with `file:line` references for any code claim. Distinguish clearly between **verified in code**, **inferred**, and **assumed/unverifiable without running it** — tag each nontrivial claim. Say explicitly when you could not check something and what you'd need to.

End with:
- A **top-10 prioritized action list** across all sections, each with: finding ID (`§n.x`), severity, effort, and the one-line fix.
- A **"things the prior reviews got wrong"** list — if it's empty, say so plainly rather than manufacturing disagreement.
- A **confidence note**: which sections you're most and least sure about.
