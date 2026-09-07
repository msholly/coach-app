-- Parent-referee sign-up: a second slot on the same public board as snacks.
-- Home games need a volunteer referee, so this table mirrors snack_signups but
-- is written only for home games (the worker enforces venue = "home"). Same
-- claim-ownership model: a parent's browser minted `claim` is the only thing
-- that can change or give up the slot; the coach can clear any of them.
--
--   npx wrangler d1 migrations apply coach-sideline-db --local
--   npx wrangler d1 migrations apply coach-sideline-db --remote

CREATE TABLE IF NOT EXISTS ref_signups (
  board_id    TEXT    NOT NULL,
  event_uid   TEXT    NOT NULL,             -- the GameChanger event UID (home game)
  name        TEXT    NOT NULL,             -- the volunteer's full name, free-form
  claim       TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (board_id, event_uid)
);
