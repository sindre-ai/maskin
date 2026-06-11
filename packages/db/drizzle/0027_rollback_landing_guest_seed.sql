-- Rolls back the landing-guest seed introduced in 0026.
-- The Bet Strategist prompt is now stored client-side (localStorage) and a
-- real agent session is created post-signup, so the shared guest actor and
-- workspace are no longer needed.

DROP INDEX IF EXISTS objects_landing_guest_throttle_idx;

DELETE FROM workspace_members
WHERE workspace_id = '00000000-0000-0000-0001-000000000002'
  AND actor_id     = '00000000-0000-0000-0001-000000000001';

DELETE FROM workspaces WHERE id = '00000000-0000-0000-0001-000000000002';

DELETE FROM actors WHERE id = '00000000-0000-0000-0001-000000000001';
