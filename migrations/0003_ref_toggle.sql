-- Referee sign-up is a per-team toggle. BU5 teams have no referees, so the coach
-- turns the referee slot off for that team's board; older/other teams keep it.
-- Turning it off only HIDES the slot on the parents' board — ref_signups rows are
-- left untouched, so flipping it back on restores who had already volunteered.
--
--   npx wrangler d1 migrations apply coach-sideline-db --local
--   npx wrangler d1 migrations apply coach-sideline-db --remote

ALTER TABLE snack_boards ADD COLUMN referees_enabled INTEGER NOT NULL DEFAULT 1;
