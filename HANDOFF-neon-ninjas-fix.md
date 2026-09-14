# Handoff — finish the Sept 12 game fix (Neon Ninjas)

**Audience:** a Chrome-based Claude agent (browser automation) with access to the coach app + the coach's device.
**Goal:** make the Sept 12 game's playing-time data show under the **real Neon Ninjas** team, then confirm it in the live app.

---

## TL;DR — what's already done vs. what's left

**Done (by the prior session):**
1. Code fix merged + deployed (backfill when a practice game is converted to real). App is live at `https://coach-sideline.calm-mud-1664.workers.dev`, worker version `feb254d3`.
2. The Sept 12 game's **archive** (games row + appearances) is correct and was **moved from "Man U" → "Neon Ninjas"** in the D1 database. Verified: appearances sum to 24.0 periods (6 on-field × 4), 4 keeper periods.

**Left to do (ONE database write, then verify):**
- Seed Neon Ninjas' **career ledger** (`played` / `kept`) with this finished game's periods. This is the missing piece — see "Why" below.
- Verify in the live app, then optionally clean up the throwaway "Man U" team.

---

## The two teams (do not mix these up)

| Name | Token / id | Role |
|---|---|---|
| **Neon Ninjas** (real, keep) | `e8f562e5a55e545f4c9368adf713d301` | Has the snack board (parent-facing). All data should live here. |
| **Man U** (throwaway) | `51188de95c0bac985a22d78692de42b5` | Working team where the game was accidentally recorded. No parent data. |

Sept 12 game id: `15edd27621dad1fcd05f407cbec8853f` (started 2026-09-12 16:36 UTC, final 1–2, 8 players, 4 periods).

---

## Why "the game shows in Season games but has no data"

Two independent representations of a game's periods exist:
1. **Archive** (`games` + `appearances` tables) → drives the season **games list** and the **position ratio (D/F)**. This is fully correct and now on Neon Ninjas.
2. **Career ledger** on the team doc (`state.played` / `state.kept`) → drives the headline **"periods played this season"** number per player (`seasonPlayed()` in `public/app.js`).

The backfill wrote **(1)** but deliberately left **(2)** to the next `commitGame` (to avoid double-counting). But `commitGame` only banks a team's *current* game — and this game is not Neon Ninjas' current game — so the career periods will never bank on their own. Result: the game is listed, but every player reads **0 periods**.

**The UI has no button to retroactively bank an already-finished/archived game into careers.** So this must be a direct DB write. (This is the whole reason a pure walk-through can't finish it.)

---

## Step 1 — Seed the career ledger (direct DB write)

Values are the exact per-player period sums from the appearances (total = 24.0; keeper = 4):

- **played**: Bearett/seed0 `3.56`, Neel/seed1 `3`, Jeffrey/seed2 `3`, Oliver/seed3 `2.62`, Reyansh/seed4 `3`, Zendrix/seed5 `3`, Connor/seed6 `2.82`, George/seed7 `3`
- **kept** (GK): seed0 `1`, seed2 `1`, seed4 `1`, seed6 `1`

The full statement is prepared at `scratchpad/neon_fix.sql`. It preserves the entire existing Neon Ninjas doc (including the upcoming Sheffield fixture) and only adds `played`/`kept`, bumping `rev` 5→6 (guarded on `rev=5` so a concurrent edit can't be clobbered).

Run against **remote production** (target confirmed by the coach):

```bash
npx wrangler d1 execute coach-sideline-db --remote --command '<contents of scratchpad/neon_fix.sql>'
```

Expect `rows_written: 1`. If it returns 0, `rev` moved past 5 — re-read the doc, re-merge `played`/`kept`, bump rev, retry.

**Reversal if needed:** the pre-fix Neon Ninjas doc had `played:{}` / `kept:{}`.
**Man U reversal (archive move):** `UPDATE games SET team_id='51188de95c0bac985a22d78692de42b5' WHERE id='15edd27621dad1fcd05f407cbec8853f';`

---

## Step 2 — Verify in the live app

1. Open the app and switch to / load the **Neon Ninjas** team (its share link, or the team switcher). Do a hard reload so the device pulls doc `rev` 6 (the coach may have been on "Man U" — make sure the active team is Neon Ninjas).
2. **Roster tab / player cards:** each player's **season periods** should read: Bearett **3.6**, Oliver **2.6**, Connor **2.8**, everyone else **3.0**. (Display rounds; stored values are 3.56/2.62/2.82.)
3. **Season games:** the Sept 12 game (1–2) is listed with per-game breakdown.
4. A **~double** number (e.g. Bearett ~7) would mean double-counting — stop and report; the archive/ledger were seeded once, so this is not expected.

Cross-check against the **photo backups** in the troubleshooting session: https://claude.ai/code/session_01HK1mqQSEDZktg5RDYmwiK3

---

## Step 3 — (optional) clean up "Man U"

Man U still holds the Sept 12 game as its *current* game in its own doc, but its archive is empty (the row moved). It has **no parent-facing data**, so it's safe to leave or remove. If the coach wants it gone, delete/reset it **only after** Step 2 verifies Neon Ninjas is correct. Do not delete anything tied to `e8f562e5…` (that's the real team + snack board).

---

## Guardrails

- **Environment:** all writes go to **remote production** `coach-sideline-db` and nowhere else, only as named above.
- **Never** overwrite the Neon Ninjas doc wholesale without preserving `team:"Neon Ninjas"`, its roster, and the Sheffield fixture — the prepared SQL already does this.
- **Read-only first:** confirm current state with `SELECT` before any write; confirm `rows_written` after.
- Career credit for the *next* game banks normally when the coach builds that game's lineup — expected, not a bug.
