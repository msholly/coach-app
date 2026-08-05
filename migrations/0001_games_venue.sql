-- Adds games.venue ("home" | "away").
--
-- schema.sql uses CREATE TABLE IF NOT EXISTS, so re-running it does NOT add a
-- column to a table that already exists — an existing database needs this file.
-- A fresh database gets the column from schema.sql and can skip it.
--
-- Non-destructive on purpose: no data is dropped, and rows written before the
-- column existed simply keep venue = NULL, which the app reads as "not recorded"
-- rather than as "home".
--
--   npx wrangler d1 execute coach-sideline-db --local  --file=./migrations/0001_games_venue.sql
--   npx wrangler d1 execute coach-sideline-db --remote --file=./migrations/0001_games_venue.sql
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; re-running this errors with
-- "duplicate column name: venue", which is safe to ignore.

ALTER TABLE games ADD COLUMN venue TEXT;
