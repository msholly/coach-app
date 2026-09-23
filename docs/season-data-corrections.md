# Season data corrections — Fall 2026

Manual corrections applied directly to the **remote/production** D1 (`coach-sideline-db`),
outside the app. Recorded here so a future session doesn't mistake hand-edited rows for a bug.
Rollback SQL for each is kept with the change.

---

## 2026-09-21 — Neon Ninjas, two corrections

**Team:** Neon Ninjas (`team_id = e8f562e5a55e545f4c9368adf713d301`). Roster: seed0=Bearett,
seed1=Neel, seed2=Jeffrey, seed3=Oliver, seed4=Reyansh, seed5=Zendrix, seed6=Connor, seed7=George.

### 1. 9/12 game — opponent + venue backfill
- Game `15edd27621dad1fcd05f407cbec8853f` (Fri 9/12/2026, lost 1–2) predated the opponent/venue
  capture, stored as `opponent=NULL, venue=home`.
- **Corrected to `opponent='Sheffield', venue='away'`** (coach confirmed it was @ Sheffield, away).
- This game also predates the `roster`/`iv` columns, so it has events + appearances only (no
  graphical replay ledger); left as-is.

### 2. 9/19 vs Cammell — substitution record ("lent players")
- Game `87c8de730c17ea2a55c67ddaa5aa81fe` (Fri 9/19/2026, **won 4–2**).
- **Why the record was wrong:** Cammell was a player short. Rather than have a Neon Ninja sit each
  period (7 present, 6 on field), the coach sent whoever would have benched to play **for Cammell**.
  Nobody actually sat, but the app has no concept of "lent to the other team," so it logged that
  time as bench time — understating four kids' minutes and skewing the season fairness/position math.
- **Bearett (seed0) was genuinely absent** for this game — left at 0, not corrected.
- **Correction:** credited the "bench" time back so all seven present players show **full time**.
  Reclaimed minutes booked as **D (field)** so GK rotation and striker stats are not distorted:
  - Jeffrey (seed2) P1 0.268 → 1.0
  - Oliver (seed3) P1 0.732 → 1.0, and P2 0 → 1.0
  - Neel (seed1) P3 → +0.983 D (keeps its 0.017 GK slice)
  - Zendrix (seed5) P4 0 → 0.228 (period was shortened; everyone's P4 = 0.228)
  - After: every present player 3.218–3.228 periods.
- Updated **both** `appearances` (drives the season fairness card, `SUM(frac)`) **and** `games.iv`
  (drives the graphical replay) so the two agree.

**Not touched (potential follow-up):** the team doc's career `played`/`kept` ledgers that auto-balance
the *next* lineup were left alone, so the balancer may still try to give those four extra minutes next
game. Fix on request.

**Rollback SQL** for both: `scratchpad/rollback_9-19.sql` (this session's scratchpad). The pre-edit
values are also recorded inline above.

### 2026-09-22 — "Zapata" clobber + follow-up

- **What happened:** right after the 9/19 edits above, the coach's live app re-synced. The 9/19 game
  was still the active game (`doc.game`) and was mis-linked to the WRONG GameChanger schedule slot
  (`doc.game.sched = {opponent:"Zapata", venue:"away", startsAt: 10/10/2026}` — a *future* game).
  `queueGameRow` re-posted from the device and overwrote the archive: opponent Cammell→**Zapata**,
  venue home→**away**, and partially reverted the playing-time rows (appearances ended up
  self-inconsistent with `games.iv`). Lesson: never edit the archive for a game that is still the
  active/syncing game on a device — the app is authoritative (last-write-wins by `updated_at`).
- **Opponent/venue — RESOLVED:** coach re-linked the 9/19 game to **Cammell / home** in the app
  (verified in the live doc: `doc.venue="home"`, `doc.game.sched.opponent="Cammell"`). But relabeling
  a *finished* game updates the doc without re-posting its archive row, so the Season tab (which reads
  the `games` table) still showed Zapata. Fixed the archive row directly — safe now because the doc
  agrees, so a re-sync writes Cammell: `UPDATE games SET opponent='Cammell', venue='home' WHERE id=…`
  (see `backups/fix-season-opponent.sql`). Verified opponent=Cammell, venue=home.
- **Playing-time ("lent to Cammell") fix — RESOLVED 2026-09-22:** coach confirmed Cammell shows on the
  Season tab and said proceed. Did a clean DELETE + reinsert of all 9/19 appearances (32 rows) + iv
  update via `backups/reconstruct-9-19-appearances.sql`. Result verified: all 7 present players full
  time (seed1/4/5/6/7=3.228, seed2=3.221, seed3=3.218), Bearett (seed0) absent, iv solid bars per
  period (P4=0.2283), opponent=Cammell/home. Reclaimed minutes booked as D.
  - **Residual risk:** at write time `doc.game.gid` was still the 9/19 game (finished but still the
    "current game"). If the app re-syncs that game as active it could re-post the original benched
    appearances and revert this. Coach advised to start/switch to the next game to lock it in. Re-verify
    with: `SELECT player_id, ROUND(SUM(frac),3) FROM appearances WHERE game_id='87c8de730c17ea2a55c67ddaa5aa81fe' GROUP BY player_id;`
- **P4 full-time credit — RESOLVED 2026-09-23:** P4 was played to full time, but the coach forgot to
  restart the clock; the `clock_set` 595→478 only credited ~2:17 (0.228). With 9/19 no longer the
  current game (doc.game moved to a new game), set every P4 appearance to 1.0 (no subs were logged in P4;
  positions unchanged) and made the P4 iv bars full (`backups/fix-9-19-p4-fulltime.sql`, backup
  `backups/coach-sideline-prod-20260923-091604-pre-p4.sql`). Verified totals: seed1/4/5/6/7 = 4.0,
  Jeffrey 3.993, Oliver 3.99.
- **Full production backups 2026-09-22:** `backups/coach-sideline-prod-20260922-102136.sql` and
  `backups/coach-sideline-prod-20260922-102956-pre-reconstruction.sql` (taken immediately before the rewrite).
