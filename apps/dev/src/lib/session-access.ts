import type { Database } from '@maskin/db'
import { actors, messages, type sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { isConversationParticipant } from '../services/spawned-sessions'
import { getWorkspaceRole } from './workspace-auth'

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
async function startedByPerson(
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
