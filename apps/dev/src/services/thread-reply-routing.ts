import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { continueEndedSession } from './session-continue'
import { TERMINAL_STATUSES } from './session-lifecycle'
import type { SessionManager } from './session-manager'

/**
 * What became of a reply posted in a thread that holds a sub-chat.
 *  - live: the sub-chat's agent is running, so the reply went into it.
 *  - continued: the sub-chat had ended, so the reply started a follow-up session.
 *  - not_delivered: the agent could not take it right now; the reply is in the thread
 *    but the agent has not seen it.
 */
export type ThreadReplyDelivery =
	| { mode: 'live'; session_id: string }
	| { mode: 'continued'; session_id: string; previous_session_id: string }
	| { mode: 'not_delivered'; session_id: string; reason: string }

interface RoutingDeps {
	db: Database
	sessionManager: SessionManager
	/** Replaceable so a test can cover the routing without launching a container. */
	continueSession?: typeof continueEndedSession
}

/**
 * A reply in the thread under a message that a sub-chat hangs from goes to that
 * sub-chat's agent, the way the thread's own composer sends it: written into the
 * session while it runs, or a follow-up session once it has ended. Without this a
 * reply posted through the API or the MCP lands in the thread as text nobody acts on.
 *
 * Returns null when the thread holds no sub-chat for the reply to go to, or when the
 * replier is that sub-chat's own agent (an agent talking in its own thread must not
 * be fed its own words back).
 *
 * The caller has already checked that `actorId` is in the conversation and that the
 * root message is a top-level message of it. That is the same entitlement the
 * follow-up route gives: anyone in the chat holding the message the sub-chat was
 * handed off from.
 */
export async function routeThreadReplyToSubSession(
	deps: RoutingDeps,
	args: {
		workspaceId: string
		rootMessageId: number
		actorId: string
		content: string
	},
): Promise<ThreadReplyDelivery | null> {
	const { db, sessionManager } = deps
	const continueSession = deps.continueSession ?? continueEndedSession

	// A sub-chat is a session with no conversation of its own, hung from a message. The
	// newest one is the live end of the thread: each follow-up hangs from the same message.
	const [latest] = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, args.workspaceId),
				eq(sessions.spawnedByMessageId, args.rootMessageId),
				isNull(sessions.conversationId),
			),
		)
		.orderBy(desc(sessions.createdAt), desc(sessions.id))
		.limit(1)
	if (!latest) return null
	if (latest.actorId === args.actorId) return null

	if (latest.status === 'running' && latest.interactive) {
		try {
			await sessionManager.writeInput(
				latest.id,
				{ type: 'user', message: { role: 'user', content: args.content } },
				undefined,
				undefined,
				// Who typed it, so the run can be read back with each message credited to its author.
				{ maskin_actor_id: args.actorId },
			)
			return { mode: 'live', session_id: latest.id }
		} catch (err) {
			logger.warn('Could not write a thread reply into its sub-chat', {
				session_id: latest.id,
				error: String(err),
			})
			return {
				mode: 'not_delivered',
				session_id: latest.id,
				reason: err instanceof Error ? err.message : String(err),
			}
		}
	}

	if ((TERMINAL_STATUSES as readonly string[]).includes(latest.status)) {
		try {
			const started = await continueSession(latest, {
				workspaceId: args.workspaceId,
				actorId: args.actorId,
				content: args.content,
			})
			return { mode: 'continued', session_id: started.sessionId, previous_session_id: latest.id }
		} catch (err) {
			logger.warn('Could not start a follow-up for a thread reply', {
				session_id: latest.id,
				error: String(err),
			})
			return {
				mode: 'not_delivered',
				session_id: latest.id,
				reason: err instanceof Error ? err.message : String(err),
			}
		}
	}

	return {
		mode: 'not_delivered',
		session_id: latest.id,
		reason: `The agent's session is ${latest.status}, so it cannot take a message yet. Post again once it is running or has ended.`,
	}
}
