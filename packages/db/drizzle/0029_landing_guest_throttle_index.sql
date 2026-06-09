-- Re-add the partial index on objects for the landing_guests workspace.
-- Dropped in 0027; needed again now that bet_draft objects are written here
-- and the workspace daily cap SELECT scans (workspace_id, type, created_at).
-- `objects` is not in the hot-tables list, so a plain CREATE INDEX is fine.

CREATE INDEX IF NOT EXISTS objects_landing_guest_throttle_idx
  ON objects (workspace_id, type, created_at)
  WHERE workspace_id = '00000000-0000-0000-0001-000000000002';
