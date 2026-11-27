-- Remove the retired Driver agent from every existing workspace.
--
-- Matches only agents whose name is exactly Driver, Workspace Driver or
-- Development Driver (type = 'agent'). A custom agent with a similar name
-- (e.g. "Night Driver") is left alone.
--
-- Deletes each matched agent with the triggers and sessions it owned, and
-- clears it wherever it was set as an object's driver. Objects, flows and
-- other agents are not deleted: rows the Driver authored are handed to a
-- human in the same workspace so the FK and the audit trail stay intact.
--
-- Emits one NOTICE per workspace with the row counts it changed, so the
-- deploy log carries the evidence. Safe to re-run: after the first pass the
-- target set is empty.
--
-- Verify after deploy (expect zero rows in every column):
--   SELECT a.name, count(*)
--   FROM actors a
--   WHERE a.type = 'agent'
--     AND a.name IN ('Driver', 'Workspace Driver', 'Development Driver')
--   GROUP BY a.name;
--   SELECT count(*) FROM objects o JOIN actors a ON a.id = o.driver
--   WHERE a.name IN ('Driver', 'Workspace Driver', 'Development Driver');
DO $$
DECLARE
	target record;
	target_ws uuid;
	fallback uuid;
	n_actors integer := 0;
	n_triggers integer := 0;
	n_sessions integer := 0;
	n_session_logs integer := 0;
	n_drivers_cleared integer := 0;
	per_agent integer;
BEGIN
	FOR target IN
		SELECT a.id, a.name
		FROM actors a
		WHERE a.type = 'agent'
			AND a.name IN ('Driver', 'Workspace Driver', 'Development Driver')
		ORDER BY a.id
	LOOP
		n_actors := n_actors + 1;
		SELECT wm.workspace_id INTO target_ws
		FROM workspace_members wm
		WHERE wm.actor_id = target.id
		LIMIT 1;

		-- Who inherits the rows this agent authored: a workspace owner, then any
		-- human member, then whoever created the workspace, then whoever created
		-- the agent. Every real workspace has a human owner, so this is non-null
		-- in practice; the last resort keeps the NOT NULL FKs satisfiable.
		SELECT coalesce(
			(
				SELECT wm.actor_id
				FROM workspace_members wm
				JOIN actors h ON h.id = wm.actor_id
				WHERE wm.workspace_id = (
					SELECT wm2.workspace_id FROM workspace_members wm2 WHERE wm2.actor_id = target.id LIMIT 1
				)
					AND h.type = 'human' AND wm.role = 'owner'
				ORDER BY wm.joined_at NULLS LAST
				LIMIT 1
			),
			(
				SELECT wm.actor_id
				FROM workspace_members wm
				JOIN actors h ON h.id = wm.actor_id
				WHERE wm.workspace_id = (
					SELECT wm2.workspace_id FROM workspace_members wm2 WHERE wm2.actor_id = target.id LIMIT 1
				)
					AND h.type = 'human'
				ORDER BY wm.joined_at NULLS LAST
				LIMIT 1
			),
			(
				SELECT w.created_by
				FROM workspaces w
				WHERE w.id = (
					SELECT wm2.workspace_id FROM workspace_members wm2 WHERE wm2.actor_id = target.id LIMIT 1
				)
			),
			(SELECT a.created_by FROM actors a WHERE a.id = target.id),
			(SELECT a.id FROM actors a WHERE a.id <> target.id ORDER BY a.created_at NULLS LAST LIMIT 1)
		)
		INTO fallback;

		-- Sessions owned by the agent, and the logs under them. Any retry pointer
		-- from another session is cleared first so the session self-FKs release.
		UPDATE sessions s
		SET retried_session_id = NULL
		WHERE s.retried_session_id IN (SELECT id FROM sessions WHERE actor_id = target.id);
		UPDATE sessions s
		SET retry_of = NULL
		WHERE s.retry_of IN (SELECT id FROM sessions WHERE actor_id = target.id);

		SELECT count(*) INTO per_agent
		FROM session_logs sl
		JOIN sessions s ON s.id = sl.session_id
		WHERE s.actor_id = target.id;
		n_session_logs := n_session_logs + per_agent;
		DELETE FROM session_logs sl
		USING sessions s
		WHERE sl.session_id = s.id AND s.actor_id = target.id;

		SELECT count(*) INTO per_agent
		FROM sessions s
		WHERE s.actor_id = target.id;
		n_sessions := n_sessions + per_agent;
		DELETE FROM sessions WHERE actor_id = target.id;

		-- Sessions the agent started for other agents survive, re-attributed.
		UPDATE sessions SET created_by = fallback WHERE created_by = target.id;

		-- The Slack DM/mention responders seeded at connect time keep working:
		-- hand them to the workspace's Chief of Staff, the agent that routes
		-- incoming work, instead of deleting them. They are identifiable by the
		-- marker the Slack integration writes.
		UPDATE triggers t
		SET target_actor_id = (
			SELECT a.id
			FROM actors a
			JOIN workspace_members wm ON wm.actor_id = a.id
			WHERE wm.workspace_id = t.workspace_id
				AND a.type = 'agent'
				AND a.name = 'Chief of Staff'
			LIMIT 1
		)
		WHERE t.target_actor_id = target.id
			AND t.metadata->>'seeded_by' = 'slack-integration-default'
			AND EXISTS (
				SELECT 1
				FROM actors a
				JOIN workspace_members wm ON wm.actor_id = a.id
				WHERE wm.workspace_id = t.workspace_id
					AND a.type = 'agent'
					AND a.name = 'Chief of Staff'
			);

		-- Every other trigger it owned or targeted.
		SELECT count(*) INTO per_agent
		FROM triggers t
		WHERE t.target_actor_id = target.id OR t.created_by = target.id;
		n_triggers := n_triggers + per_agent;
		DELETE FROM triggers WHERE target_actor_id = target.id OR created_by = target.id;

		-- Surviving triggers that name it as a hand-off or escalation target.
		UPDATE triggers SET hands_off_to_actor_id = NULL WHERE hands_off_to_actor_id = target.id;
		UPDATE triggers SET escalates_to_actor_id = NULL WHERE escalates_to_actor_id = target.id;

		-- Per-agent bookkeeping and history that cannot outlive the actor row.
		DELETE FROM agent_files WHERE actor_id = target.id;
		DELETE FROM notifications WHERE source_actor_id = target.id OR target_actor_id = target.id;
		DELETE FROM events WHERE actor_id = target.id;
		DELETE FROM relationships WHERE created_by = target.id;
		DELETE FROM subscriptions WHERE actor_id = target.id;
		DELETE FROM read_state WHERE actor_id = target.id;
		DELETE FROM star_state WHERE actor_id = target.id;
		DELETE FROM conversation_pending_turns WHERE actor_id = target.id;
		DELETE FROM voice_sessions WHERE agent_actor_id = target.id OR human_actor_id = target.id;
		DELETE FROM orphan_thread_detections WHERE expected_reply_actor_id = target.id;
		DELETE FROM comment_mentions WHERE actor_id = target.id;

		UPDATE conversation_participants SET added_by = NULL WHERE added_by = target.id;
		DELETE FROM conversation_participants WHERE actor_id = target.id;

		-- The agent as an object driver is cleared; rows it authored stay.
		SELECT count(*) INTO per_agent
		FROM objects o
		WHERE o.driver = target.id;
		n_drivers_cleared := n_drivers_cleared + per_agent;
		UPDATE objects SET driver = NULL WHERE driver = target.id;
		UPDATE objects SET created_by = fallback WHERE created_by = target.id;

		UPDATE files SET created_by = fallback WHERE created_by = target.id;
		UPDATE imports SET created_by = fallback WHERE created_by = target.id;
		UPDATE messages SET actor_id = fallback WHERE actor_id = target.id;
		UPDATE conversations SET created_by = fallback WHERE created_by = target.id;
		UPDATE workspace_invitations SET invited_by_actor_id = fallback WHERE invited_by_actor_id = target.id;
		UPDATE file_comments SET author_id = fallback WHERE author_id = target.id;
		UPDATE file_comments SET resolved_by = NULL WHERE resolved_by = target.id;
		UPDATE file_proposals SET author_id = fallback WHERE author_id = target.id;
		UPDATE file_proposal_changes SET decided_by = NULL WHERE decided_by = target.id;
		UPDATE file_uploads SET created_by = fallback WHERE created_by = target.id;
		UPDATE extensions SET created_by = NULL WHERE created_by = target.id;
		UPDATE workspace_skills SET created_by = NULL WHERE created_by = target.id;
		UPDATE integrations SET created_by = fallback WHERE created_by = target.id;

		-- An integration the agent alone owned goes with it (its credentials).
		DELETE FROM integrations WHERE actor_id = target.id;

		DELETE FROM workspace_members WHERE actor_id = target.id;
		UPDATE workspaces SET billing_owner_id = NULL WHERE billing_owner_id = target.id;
		UPDATE workspaces SET created_by = NULL WHERE created_by = target.id;
		-- A workspace whose default chat agent was the Driver falls back to the
		-- app's normal behaviour rather than keeping a dangling id.
		UPDATE workspaces
		SET settings = settings - 'default_agent_id'
		WHERE settings->>'default_agent_id' = target.id::text;

		UPDATE actors SET created_by = NULL WHERE created_by = target.id;
		DELETE FROM actors WHERE id = target.id;

		RAISE NOTICE 'Driver removal: workspace % agent "%" (%) removed', target_ws, target.name, target.id;
	END LOOP;

	RAISE NOTICE 'Driver removal total: % agents, % triggers, % sessions, % session logs, % object driver slots',
		n_actors, n_triggers, n_sessions, n_session_logs, n_drivers_cleared;
END $$;
