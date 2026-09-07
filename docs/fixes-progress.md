# Fixes progress tracker

Tracks implementation of the two review handoffs. One row per group.
Status: `todo` / `in-progress` / `done` / `deferred`. Record the `npm test` count and date on completion.

> Baselines: infrastructure handoff = 115/115; product handoff = 119/119.

## Infrastructure audit fixes — [infrastructure-fixes-handoff.md](infrastructure-fixes-handoff.md)

| Group | Scope | Status | Tests | Date | Notes |
|-------|-------|--------|-------|------|-------|
| 1 | Security hotfix (S1 schedule 404 + M3 alarm try/catch) | done | — | — | staged, in infra commit |
| 2 | Deploy hygiene (C3/C5/C4) | done | — | — | staged |
| 3 | Lost-write race in putTeam (C1) | done | — | — | staged |
| 4 | Migrations overhaul (C2) — **touches PROD** | done | — | — | staged (schema→0000_init) |
| 5 | DRY cleanups (D1/D2) | done | — | — | staged |

> Infra groups 1–5 implemented and staged; confirm `npm test` ≥115 after the infra commit lands.

## Product review fixes — [product-fixes-handoff.md](product-fixes-handoff.md)

| Group | Scope | Status | Tests | Date | Notes |
|-------|-------|--------|-------|------|-------|
| 1 | Playing-time truth (§1.1/§2.1/§2.2) | done | 121/121 | 2026-08-12 | finalizeAtElapsed clips ledgers at game end; label Plays→Scheduled; sw CACHE v16; bug-176 |
| 2 | Silent storage failure (§5.1) | todo | — | — | |
| 3 | First-run unusable roster (§9.1) | todo | — | — | |
| 4 | Season lifecycle & data hygiene (§7.1) | todo | — | — | |
| 5 | Delete dead weight (§12.1/§2.1/§4.1) + a11y from G7 | todo | — | — | |
| 6 | Journey tests (§10.1) | todo | — | — | |
| 7 | Game Day redesign (§6.1) | deferred | — | — | needs user design decision |
| 8 | Drill content (§8.1) | deferred | — | — | separate session, guide open |
