import type { Database } from '@maskin/db'
import { actors, messages, type sessions } from '@maskin/db/schema'
import { type SQL, eq, sql } from 'drizzle-orm'
import { isConversationParticipant } from '../services/spawned-sessions'
import { getWorkspaceRole, isWorkspaceHumanAdminOrOwner } from './workspace-auth'

type SessionRow = typeof sessions.$inferSelect

/** Where a helper session (started by another agent in a chat) asks its questions. */
export function helperAskConversationId(session: Pick<SessionRow, 'conversationId' | 'config'>) {
	if (session.conversationId) return null
	const id = (session.config as { ask_conversation_id?: unknown } | null)?.ask_conversation_id
	return typeof id === 'string' ? id : null
}

/** The caller's role: from the request context when the middleware set it, else looked up. */
async function resolveRole(
	db: Database,
	session: Pick<SessionRow, 'workspaceId'>,
	actorId: string,
	knownRole: string | undefined,
) {
	return knownRole ?? (await getWorkspaceRole(db, actorId, session.workspaceId))
}

const isAdminRole = (role: string | null | undefined) => role === 'owner' || role === 'admin'

/**
 * A session a person started is private to them. One started by a trigger or by
 * an agent is shared work, readable by every member of the workspace.
 */
export async function startedByPerson(
	db: Database,
	session: Pick<SessionRow, 'triggerId' | 'createdBy'>,
): Promise<boolean> {
	if (session.triggerId) return false
	const [creator] = await db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, session.createdBy))
		.limit(1)
	return creator?.type === 'human'
}

/**
 * Background work no chat owns: started by a trigger or an agent, with no chat of its own and
 * none it asks in. Like reading it, writing to it is open to the workspace's people (the route
 * keeps other agents out), since
 * there is no one person or chat to scope it to.
 */
export async function isSharedBackgroundSession(
	db: Database,
	session: Pick<SessionRow, 'conversationId' | 'config' | 'triggerId' | 'createdBy'>,
): Promise<boolean> {
	if (session.conversationId || helperAskConversationId(session)) return false
	return !(await startedByPerson(db, session))
}

/** The chats a session shows up in: its own, the one a helper asks in, and its anchor message's. */
async function chatsOf(db: Database, session: SessionRow): Promise<string[]> {
	const ids = new Set<string>()
	if (session.conversationId) ids.add(session.conversationId)
	const asking = helperAskConversationId(session)
	if (asking) ids.add(asking)
	if (session.spawnedByMessageId !== null) {
		const [anchor] = await db
			.select({ conversationId: messages.conversationId })
			.from(messages)
			.where(eq(messages.id, session.spawnedByMessageId))
			.limit(1)
		if (anchor) ids.add(anchor.conversationId)
	}
	return [...ids]
}

/**
 * Who may read a session's detail and logs: whoever started it, a workspace
 * admin or owner, anyone in a chat the session belongs to, and every member when
 * the session was started by a trigger or an agent.
 */
export async function canReadSession(
	db: Database,
	session: SessionRow,
	actorId: string,
	workspaceRole?: string,
): Promise<boolean> {
	if (session.createdBy === actorId) return true
	if (isAdminRole(await resolveRole(db, session, actorId, workspaceRole))) return true
	if (!(await startedByPerson(db, session))) return true
	for (const conversationId of await chatsOf(db, session)) {
		if (await isConversationParticipant(db, conversationId, actorId)) return true
	}
	return false
}

/** Who may stop, pause or resume a session: whoever started it, or a workspace admin or owner. */
export async function canControlSession(
	db: Database,
	session: SessionRow,
	actorId: string,
	workspaceRole?: string,
): Promise<boolean> {
	if (session.createdBy === actorId) return true
	return isAdminRole(await resolveRole(db, session, actorId, workspaceRole))
}

/**
 * The list route's twin of canReadSession, as a SQL condition so it applies before
 * the page is cut and paging stays stable. Admins and owners see everything, so
 * they get no condition. The columns are written out table-qualified on purpose:
 * Drizzle renders column objects unqualified inside a correlated subquery.
 */
export async function sessionListVisibility(
	db: Database,
	workspaceId: string,
	actorId: string,
	workspaceRole?: string,
): Promise<SQL | undefined> {
	if (isAdminRole(await resolveRole(db, { workspaceId }, actorId, workspaceRole))) return undefined
	return sql`(
		sessions.created_by = ${actorId}
		OR sessions.trigger_id IS NOT NULL
		OR NOT EXISTS (
			SELECT 1 FROM actors creator
			WHERE creator.id = sessions.created_by AND creator.type = 'human'
		)
		OR EXISTS (
			SELECT 1 FROM conversation_participants cp
			WHERE cp.actor_id = ${actorId} AND cp.left_at IS NULL
			AND (
				cp.conversation_id = sessions.conversation_id
				OR (sessions.conversation_id IS NULL AND cp.conversation_id::text = sessions.config->>'ask_conversation_id')
				OR cp.conversation_id = (SELECT m.conversation_id FROM messages m WHERE m.id = sessions.spawned_by_message_id)
			)
		)
	)`
}

/**
 * Who may change a session's status line: the agent running it, whoever started
 * it, or a human workspace admin or owner. Agents write the line with their own
 * key, so an agent only passes as the session's actor, never as an admin.
 */
export async function canUpdateSessionActivity(
	db: Database,
	session: Pick<SessionRow, 'actorId' | 'createdBy' | 'workspaceId'>,
	actorId: string,
): Promise<boolean> {
	if (session.actorId === actorId || session.createdBy === actorId) return true
	return isWorkspaceHumanAdminOrOwner(db, actorId, session.workspaceId)
}
