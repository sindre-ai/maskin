import { describe, expect, it } from 'vitest'
import { sql } from './global-setup'

// Account deletion keeps the actor row (records elsewhere reference it) and scrubs it, so the
// ON DELETE CASCADE of a foreign key to `actors` never fires. Every table that references an
// actor therefore has to be answered for here: erased by `POST /api/account/delete`, or kept on
// purpose with a reason. A new table with an actor column fails this test until someone decides
// which, which is how the push-token tables were missed the first time.

/** Deleted by routes/account.ts. */
const ERASED = new Set([
	'api_keys',
	'device_auth_codes',
	'device_tokens',
	'live_activity_cards',
	'live_activity_tokens',
	'notification_preferences',
	'notifications',
	'read_state',
	'slack_user_links',
	'star_state',
	'subscriptions',
	'user_display_settings',
	'web_push_subscriptions',
	'workspace_members',
])

/** Kept on purpose: table -> why. Keep this short and honest. */
const KEPT: Record<string, string> = {
	// Attribution: the actor stays as a "Deleted user" so what they made keeps its author.
	actors: 'self-reference (created_by / owner); the row itself is scrubbed, not deleted',
	events: 'audit log; the actor is shown as a deleted user',
	objects: 'content authored or driven by the person is kept, attributed to the deleted user',
	relationships: 'content edge created by the person is kept',
	messages: 'chat content is kept, attributed to the deleted user',
	message_reactions: 'attached to kept messages',
	message_thread_reads: 'attached to kept threads',
	conversations: 'created_by on a kept conversation',
	conversation_participants: 'membership record of a kept conversation',
	conversation_pending_turns: 'agent turn queue of a kept conversation (agent actor, not a person)',
	files: 'content authored by the person is kept',
	file_comments: 'content authored by the person is kept',
	workspace_skills: 'created_by on workspace content',
	workspaces: 'created_by / billing_owner_id; deletion is blocked until billing is handed over',
	triggers: 'created_by / target agent on workspace automation',
	sessions: 'agent run history; actor is the agent or the person who started it',
	voice_sessions: 'call record in a kept workspace',
	imports: 'import record in a kept workspace',
	orphan_thread_detections: 'internal detector state keyed on a kept thread',
	// Agent-side tables: the actor_id is an agent, not the person.
	agent_files: 'belongs to an agent actor',
	agent_skills: 'belongs to an agent actor',
	agent_grants: 'grants to an agent actor; created_by is attribution',
	agent_chat_grants: 'grants to an agent actor; created_by is attribution',
	// Known gaps, not fixed here (follow-up): these can still carry the person's identity.
	integrations:
		'FOLLOW-UP: actor_id = who connected it; may hold a personal credential. Workspace-owned, so not erased here',
	workspace_invitations:
		'FOLLOW-UP: invited_by / accepted_by on invites; may keep an invitee email after the account is erased',
}

describe('guard: account deletion answers for every table that references an actor', () => {
	it('erases or explicitly keeps each one', async () => {
		const rows = await sql<{ child: string }[]>`
			SELECT DISTINCT c.conrelid::regclass::text AS child
			FROM pg_constraint c
			WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
				AND c.confrelid = 'actors'::regclass`
		const children = rows.map((r) => r.child).sort()

		const unhandled = children.filter((t) => !ERASED.has(t) && !(t in KEPT))
		expect(
			unhandled,
			'a table references actors but account deletion neither erases it (routes/account.ts) nor lists it in KEPT with a reason',
		).toEqual([])

		const real = new Set(children)
		const stale = [...ERASED, ...Object.keys(KEPT)].filter((t) => !real.has(t))
		expect(stale, 'these entries no longer reference actors').toEqual([])
	})
})
