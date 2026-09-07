-- Snack sign-up: a public board per team, reached by its OWN unguessable link.
-- The team token grants every write to the team doc, so it can never be the
-- thing handed to twelve families; the board id is a second, narrower
-- capability. Whoever holds it sees every signup and can take an open game.
--
--   npx wrangler d1 migrations apply coach-sideline-db --local
--   npx wrangler d1 migrations apply coach-sideline-db --remote

-- One GameChanger feed PER TEAM. GC_ICS_URL is a single secret and can only
-- describe one team; a coach with two teams pastes each team's "Subscribe to
-- calendar" link in the app and it lands here. NULL = fall back to the secret.
-- Plain ALTER: this file is tracked by the migrations framework and runs once.
ALTER TABLE teams ADD COLUMN ics_url TEXT;

CREATE TABLE IF NOT EXISTS snack_boards (
  id          TEXT    PRIMARY KEY,          -- the parents' link token, minted once per team
  team_id     TEXT    NOT NULL UNIQUE,      -- one board per team, so the link never changes
  created_at  INTEGER NOT NULL
);

-- One family per game. The game is the GameChanger event UID, so a rescheduled
-- game keeps its signup. `claim` is a random token the signer's browser minted
-- and keeps: it is the only thing that lets a slot be changed or given up, so
-- one family cannot quietly remove another. The coach can clear any slot.
CREATE TABLE IF NOT EXISTS snack_signups (
  board_id    TEXT    NOT NULL,
  event_uid   TEXT    NOT NULL,
  name        TEXT    NOT NULL,             -- "Sholly family", "Bearett's mom"
  note        TEXT,                         -- "orange slices + juice boxes"
  claim       TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (board_id, event_uid)
);
