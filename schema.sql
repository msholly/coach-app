-- Coach's Sideline — D1 schema
-- One row per team. The whole app state (roster, lineups, practice plan, game state)
-- lives in `doc` as a JSON string. `rev` powers optimistic-concurrency; `updated_at`
-- (ms epoch) is the last-write clock the client uses to decide who's newer.

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT    PRIMARY KEY,          -- unguessable token (also the share link)
  doc         TEXT    NOT NULL,             -- JSON app state
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,             -- ms since epoch, server-stamped on write
  created_at  INTEGER NOT NULL
);

-- Append-only archive beside the live doc. The doc stays the only thing game
-- day depends on; these tables are flushed opportunistically from a client
-- outbox with client-generated ids, so every write is idempotent and retry
-- is free. They exist because a season-long position ratio is underivable
-- from the single-doc model (plan finding 1.3).

-- One row per game played. Written once at kickoff, updated at full time.
CREATE TABLE IF NOT EXISTS games (
  id          TEXT    PRIMARY KEY,          -- client-generated, so kickoff works offline
  team_id     TEXT    NOT NULL,
  season      TEXT    NOT NULL,             -- "Fall 2026" — the ledger reset boundary
  format      TEXT    NOT NULL,             -- "u8" | "bu5" — decides whether GK is meaningful
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  opponent    TEXT,
  venue       TEXT,                           -- "home" | "away", NULL on rows written before this column
  us          INTEGER NOT NULL DEFAULT 0,
  them        INTEGER NOT NULL DEFAULT 0,
  periods     INTEGER NOT NULL,
  onfield     INTEGER NOT NULL,
  minsper     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_games_team ON games(team_id, season);

-- Requirement 2. Append-only; never updated, never deleted.
CREATE TABLE IF NOT EXISTS game_events (
  id        TEXT    PRIMARY KEY,            -- client-generated => POST is idempotent
  game_id   TEXT    NOT NULL,
  at        INTEGER NOT NULL,               -- ms epoch, client clock
  period    INTEGER NOT NULL,
  secs      INTEGER NOT NULL,               -- clock remaining when it happened
  kind      TEXT    NOT NULL,               -- goal | sub | keeper | period | clock
  player_id TEXT,
  detail    TEXT                            -- JSON, kind-specific
);
CREATE INDEX IF NOT EXISTS ix_events_game ON game_events(game_id, at);

-- Requirement 3. The table that makes a season-long position ratio possible at all.
-- pos is in the key because a mid-period sub splits one period across two positions.
CREATE TABLE IF NOT EXISTS appearances (
  game_id   TEXT NOT NULL,
  player_id TEXT NOT NULL,
  period    INTEGER NOT NULL,
  pos       TEXT NOT NULL,                  -- GK | D | F
  frac      REAL NOT NULL DEFAULT 1,        -- 0.7 when they came off at 3:00 of 10:00
  PRIMARY KEY (game_id, player_id, period, pos)
);
CREATE INDEX IF NOT EXISTS ix_app_player ON appearances(player_id, pos);

-- Web push endpoints, one row per installed PWA that opted in. The whole
-- PushSubscription is kept as JSON so the keys are already there if the push
-- payload ever needs encrypting; today's sends are payload-less (VAPID only).
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT    PRIMARY KEY,          -- the push service URL, unique per install
  team_id    TEXT    NOT NULL,
  sub        TEXT    NOT NULL,             -- JSON PushSubscription
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_push_team ON push_subs(team_id);
