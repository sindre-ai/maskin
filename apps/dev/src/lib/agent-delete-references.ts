/**
 * Every column with a foreign key to actors.id that has no cascade or set-null rule, so a row
 * naming the actor blocks deleting it. The delete route in routes/actors.ts clears each one
 * (delete the row, hand it to the person deleting, or null the column); the integration test
 * agent-delete-references.test.ts compares this list with the database catalog and fails when
 * a new foreign key to actors is added without the route handling it.
 */
export const AGENT_DELETE_HANDLED_REFERENCES = [
	'actors.created_by',
	'agent_files.actor_id',
	'conversation_participants.actor_id',
	'conversation_participants.added_by',
	'conversation_pending_turns.actor_id',
	'conversations.created_by',
	'events.actor_id',
	'extensions.created_by',
	'file_comments.author_id',
	'file_comments.resolved_by',
	'file_proposal_changes.decided_by',
	'file_proposals.author_id',
	'file_uploads.created_by',
	'files.created_by',
	'imports.created_by',
	'integrations.actor_id',
	'integrations.created_by',
	'messages.actor_id',
	'notifications.source_actor_id',
	'notifications.target_actor_id',
	'objects.created_by',
	'objects.driver',
	'orphan_thread_detections.expected_reply_actor_id',
	'read_state.actor_id',
	'relationships.created_by',
	'sessions.actor_id',
	'sessions.created_by',
	'star_state.actor_id',
	'subscriptions.actor_id',
	'triggers.created_by',
	'triggers.escalates_to_actor_id',
	'triggers.hands_off_to_actor_id',
	'triggers.target_actor_id',
	'voice_sessions.agent_actor_id',
	'voice_sessions.human_actor_id',
	'workspace_invitations.invited_by_actor_id',
	'workspace_members.actor_id',
	'workspace_skills.created_by',
	'workspaces.billing_owner_id',
	'workspaces.created_by',
] as const
