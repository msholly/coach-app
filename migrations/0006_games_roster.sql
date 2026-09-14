-- Snapshot the roster with each game so history survives a later rename or removal.
-- The archive stores only player_ids (in appearances/events); if a player is renamed
-- or dropped from the current roster, past games would show the wrong name or none.
-- Keep a point-in-time copy: JSON array of {id, name, num} as the roster stood at
-- archive time. Reports read the game's own snapshot, not the mutable live roster.
ALTER TABLE games ADD COLUMN roster TEXT;
