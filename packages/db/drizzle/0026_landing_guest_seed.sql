-- Seed the shared `landing_guest` system actor and singleton `landing_guests`
-- workspace that back the public POST /api/public/bet-strategist/drafts
-- endpoint. Every guest landing-page draft is stamped with createdBy =
-- this actor and persisted as a bet_draft object in this workspace. Cookies
-- and IPs ride in metadata; the auth allowlist exempts the route from the
-- bearer-token check, so the actor's api_key is never validated as a bearer
-- token (it does not start with `ank_`, so even if leaked it cannot
-- authenticate against the API).
--
-- Deterministic UUIDs are used so backups, dev resets, and the signup flow
-- (Task 7) can reference these rows by id without a lookup.

INSERT INTO actors (id, type, name, is_system, api_key, description)
VALUES (
  '00000000-0000-0000-0001-000000000001',
  'system',
  'Landing Guest',
  TRUE,
  'system:landing_guest:' || gen_random_uuid(),
  'Shared system actor for landing-page guest drafts. Never used as a real signed-in identity.'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspaces (id, name, created_by, settings)
VALUES (
  '00000000-0000-0000-0001-000000000002',
  'Landing Guests',
  '00000000-0000-0000-0001-000000000001',
  jsonb_build_object(
    'purpose', 'landing_page_guest_drafts',
    'visible_in_workspace_picker', false
  )
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_members (workspace_id, actor_id, role)
VALUES (
  '00000000-0000-0000-0001-000000000002',
  '00000000-0000-0000-0001-000000000001',
  'owner'
)
ON CONFLICT (workspace_id, actor_id) DO NOTHING;

-- Throttle queries scan objects on this workspace by (type, metadata->>'guestSessionId')
-- and (type, metadata->>'ip', created_at). A partial index keeps those counts cheap as
-- guest traffic grows.
CREATE INDEX IF NOT EXISTS objects_landing_guest_throttle_idx
  ON objects (workspace_id, type, created_at)
  WHERE workspace_id = '00000000-0000-0000-0001-000000000002';
