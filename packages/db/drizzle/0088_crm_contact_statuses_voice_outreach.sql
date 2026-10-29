-- Carry the voice-outreach contact statuses to workspaces that already have crm on.
--
-- CONTACT_STATUSES in extensions/crm/shared.ts only seeds workspaces that enable
-- crm from now on: mergeModuleDefaultSettings lets a workspace's stored
-- settings.statuses.contact always win, and objects create / update validate
-- status against that stored list (400 Invalid status). Without this, no API or
-- MCP write of a voice_* status, rejected or deleted_by_request succeeds in an
-- existing workspace.
--
-- Append only: existing entries keep their order and nothing is removed. A
-- status already in the list is skipped, so running this twice leaves the list
-- identical to running it once. Workspaces with crm off, or with crm on but no
-- stored contact list, are untouched (a fresh enablement seeds the defaults).
UPDATE workspaces
SET settings = jsonb_set(
	settings,
	'{statuses,contact}',
	(settings->'statuses'->'contact') || COALESCE(
		(
			SELECT jsonb_agg(to_jsonb(t.status) ORDER BY t.ord)
			FROM unnest(ARRAY[
				'voice_queued',
				'voice_dialing',
				'voice_answered',
				'voice_no_answer',
				'voice_busy',
				'voice_voicemail',
				'voice_declined',
				'voice_meeting_booked',
				'voice_warm_transferred',
				'voice_failed',
				'rejected',
				'deleted_by_request'
			]) WITH ORDINALITY AS t(status, ord)
			WHERE NOT ((settings->'statuses'->'contact') @> to_jsonb(t.status))
		),
		'[]'::jsonb
	)
)
WHERE (settings->'enabled_modules') @> '"crm"'::jsonb
	AND jsonb_typeof(settings->'statuses'->'contact') = 'array';
