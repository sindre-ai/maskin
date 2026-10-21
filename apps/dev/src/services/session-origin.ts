import type { Database } from '@maskin/db'
import { actors, conversationParticipants, sessions } from '@maskin/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { startedByPerson } from '../lib/session-access'

type SessionRow = typeof sessions.$inferSelect

export type SessionOriginRow = Pick<
	SessionRow,
	| 'id'
	| 'workspaceId'
	| 'actorId'
	| 'triggerId'
	| 'createdBy'
	| 'conversationId'
	| 'spawnedBySessionId'
	| 'config'
>

/**
 * Most session rows the walk reads. Helper links stop at hop depth 3
 * (MENTION_GUARD_LIMITS.maxHopDepth), so a chain longer than this has no
 * accepted link beyond it anyway.
 */
const MAX_WALK_NODES = 4

/**
 * The chat a session's work belongs to: its own conversation, else the one
 * stamped on it at spawn (origin_conversation_id), else the one a helper asks
 * its questions in (ask_conversation_id). Pure. Routing and the intro both call
 * this, so they never disagree about what "origin chat" means.
 */
export function originConversationOf(
	session: Pick<SessionRow, 'conversationId' | 'config'>,
): string | null {
	if (session.conversationId) return session.conversationId
	const config = session.config as {
		origin_conversation_id?: unknown
		ask_conversation_id?: unknown
	} | null
	for (const id of [config?.origin_conversation_id, config?.ask_conversation_id]) {
		if (typeof id === 'string' && id.length > 0) return id
	}
	return null
}

export type HumanBehindSession =
	| { ok: true; humanId: string; via: 'chat' | 'person_started'; hops: number }
	| {
			ok: false
			reason: 'no_session' | 'session_claim_invalid' | 'unattended_origin' | 'origin_group_chat'
	  }

async function loadSession(db: Database, id: string): Promise<SessionOriginRow | null> {
	const [row] = await db
		.select({
			id: sessions.id,
			workspaceId: sessions.workspaceId,
			actorId: sessions.actorId,
			triggerId: sessions.triggerId,
			createdBy: sessions.createdBy,
			conversationId: sessions.conversationId,
			spawnedBySessionId: sessions.spawnedBySessionId,
			config: sessions.config,
		})
		.from(sessions)
		.where(eq(sessions.id, id))
		.limit(1)
	return row ?? null
}

/**
 * Chat leg for conversation `conversationId`. When the node is the chat session
 * itself and the person who woke it is an active participant, that person (also
 * right in a group chat). Otherwise the chat's single active human. Anything
 * else is a group chat, which gets no one.
 */
async function humanInChat(
	db: Database,
	node: SessionOriginRow,
	conversationId: string,
	ownChat: boolean,
	hops: number,
): Promise<HumanBehindSession> {
	const humans = await db
		.select({ id: conversationParticipants.actorId })
		.from(conversationParticipants)
		.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
		.where(
			and(
				eq(conversationParticipants.conversationId, conversationId),
				isNull(conversationParticipants.leftAt),
				eq(actors.type, 'human'),
			),
		)
	const humanIds = humans.map((h) => h.id)
	if (ownChat && humanIds.includes(node.createdBy)) {
		return { ok: true, humanId: node.createdBy, via: 'chat', hops }
	}
	const [only] = humanIds
	if (humanIds.length === 1 && only) return { ok: true, humanId: only, via: 'chat', hops }
	return { ok: false, reason: 'origin_group_chat' }
}

/**
 * The person an agent's session is working for, found by walking pointers that
 * already exist on session rows (own chat, who started it, who spawned it).
 * Used to pick who gets the intro when an agent creates an agent.
 *
 * The header claim is checked against the authenticated creator and workspace
 * first. A finished session of the same actor is still a valid claim. This does
 * not call resolveSpawnLink: that one refuses finished sessions, enforces the
 * hop cap and writes guard events, none of which belong here.
 *
 * A session started by a trigger (cron, loop, event) never resolves to a human,
 * even when a human created the trigger: created_by is whoever set the trigger
 * up, not whoever asked.
 */
export async function resolveHumanBehindSession(
	db: Database,
	args: { claimedSessionId: string | null | undefined; creatorId: string; workspaceId: string },
): Promise<HumanBehindSession> {
	if (!args.claimedSessionId) return { ok: false, reason: 'no_session' }

	const claimed = await loadSession(db, args.claimedSessionId)
	if (!claimed || claimed.actorId !== args.creatorId || claimed.workspaceId !== args.workspaceId) {
		return { ok: false, reason: 'session_claim_invalid' }
	}

	let node = claimed
	for (let hops = 0; hops < MAX_WALK_NODES; hops++) {
		if (node.conversationId) return humanInChat(db, node, node.conversationId, true, hops)

		if (await startedByPerson(db, node)) {
			return { ok: true, humanId: node.createdBy, via: 'person_started', hops }
		}

		if (hops < MAX_WALK_NODES - 1 && node.spawnedBySessionId) {
			const parent = await loadSession(db, node.spawnedBySessionId)
			if (parent && parent.workspaceId === args.workspaceId) {
				node = parent
				continue
			}
		}

		const origin = originConversationOf(node)
		if (origin) return humanInChat(db, node, origin, false, hops)
		return { ok: false, reason: 'unattended_origin' }
	}
	return { ok: false, reason: 'unattended_origin' }
}
