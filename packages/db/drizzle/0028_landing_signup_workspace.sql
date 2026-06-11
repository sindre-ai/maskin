-- Re-seeds the landing-guests system actor and workspace removed in 0027.
-- Now used only for landing_signup objects (not bet_drafts): when a
-- landing-page visitor signs up, the signup_complete landing event is
-- persisted as a landing_signup object here so admin-landing-funnel can
-- compute signupsFromGuests and conversionRate from the DB.

INSERT INTO actors (id, type, name, is_system, api_key, description)
VALUES (
  '00000000-0000-0000-0001-000000000001',
  'system',
  'Landing Guest',
  TRUE,
  'system:landing_guest:' || gen_random_uuid(),
  'System actor for landing-page funnel objects. Never used as a signed-in identity.'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspaces (id, name, created_by, settings)
VALUES (
  '00000000-0000-0000-0001-000000000002',
  'Landing Guests',
  '00000000-0000-0000-0001-000000000001',
  jsonb_build_object(
    'purpose', 'landing_page_funnel',
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
