-- Cross-device team-list sync. A device's list of teams was until now pure
-- localStorage: open the app on a new phone and it knows only the team links
-- that phone has opened. This adds a "coach id" (cid) — a third unguessable
-- capability token, alongside the team token and the snack-board token — that
-- owns a JSON list of {tok,name} and syncs it across a coach's own devices.
--
-- The cid unlocks every team on the list, so it is exactly as sensitive as the
-- bundle of team links it carries: it is shared deliberately, once, via the
-- "Link another device" link (#c=<cid>), never bundled into a team share link.
--
--   npx wrangler d1 migrations apply coach-sideline-db --local
--   npx wrangler d1 migrations apply coach-sideline-db --remote

-- One row per coach id. Same last-write-wins + optimistic-concurrency (rev)
-- shape as the teams table, so the client reuses the baseRev conflict dance.
-- The doc is a JSON array: [{ "tok": "...", "name": "..." }].
CREATE TABLE IF NOT EXISTS coaches (
  id          TEXT    PRIMARY KEY,       -- the cid: an unguessable device-sync token
  doc         TEXT    NOT NULL,          -- JSON array of { tok, name }
  rev         INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
