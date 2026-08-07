-- Adds teams.pass_hash (optional per-team login passphrase).
-- NULL means the team is unlocked: holding the share link is the only gate,
-- exactly as it was before this column existed.
--
--   npx wrangler d1 execute coach-sideline-db --local  --file=./migrations/0002_teams_pass.sql
--   npx wrangler d1 execute coach-sideline-db --remote --file=./migrations/0002_teams_pass.sql
--
-- Also the recovery path: there is no email on file, so a coach who forgets the
-- passphrase is unlocked by hand.
--   npx wrangler d1 execute coach-sideline-db --remote \
--     --command="UPDATE teams SET pass_hash = NULL WHERE id = '<token>'"

ALTER TABLE teams ADD COLUMN pass_hash TEXT;
