-- Persist the interval ledger per game. lu.iv records WHERE inside each period a
-- player's minutes fell (leave-and-return shows a real break) — the same data the
-- live Game Day track bars draw. It was display-only and never archived, so past
-- games had no way to show subs graphically. Keep it now: storage is cheap and it
-- lets the Season archive replay a game and future reports read exact sub timing.
-- JSON: iv[qIndex] = { player_id: [[on, off], ...] } in fractions of the period.
ALTER TABLE games ADD COLUMN iv TEXT;
