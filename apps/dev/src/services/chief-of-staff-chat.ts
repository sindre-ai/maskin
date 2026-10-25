import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversations,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'

const CHIEF_OF_STAFF_NAME = 'Chief of Staff'
const CHAT_TITLE = 'Chief of Staff'

export async function findChiefOfStaffId(
	db: Database,
	workspaceId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, CHIEF_OF_STAFF_NAME),
				eq(actors.type, 'agent'),
			),
		)
		.limit(1)
	return row?.actorId ?? null
}

/**
 * The person an autonomous session's question is for: whoever started it when
 * that is a human, otherwise the workspace's longest-standing owner. A
 * trigger-driven run has no human of its own to point at.
 */
export async function resolveAskTargetHuman(
	db: Database,
	workspaceId: string,
	createdBy: string,
): Promise<string | null> {
	const [creator] = await db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, createdBy))
		.limit(1)
	if (creator?.type === 'human') return createdBy

	const [owner] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.role, 'owner'),
				eq(actors.type, 'human'),
			),
		)
		.orderBy(asc(workspaceMembers.joinedAt))
		.limit(1)
	return owner?.actorId ?? null
}

/**
 * The one 1-1 conversation between a person and the workspace's Chief of Staff,
 * created on first use. "1-1" is not stored anywhere: it is a conversation whose
 * only two active participants are these two, which is also how the responder
 * decides to answer every message in it. Returns null when the workspace has no
 * Chief of Staff, so the caller can fall back to its old behaviour.
 */
export async function ensureChiefOfStaffChat(
	db: Database,
	workspaceId: string,
	humanId: string,
): Promise<{ conversationId: string; chiefOfStaffId: string } | null> {
	const chiefOfStaffId = await findChiefOfStaffId(db, workspaceId)
	if (!chiefOfStaffId) return null

	const mine = db
		.select({ conversationId: conversationParticipants.conversationId })
		.from(conversationParticipants)
		.where(
			and(eq(conversationParticipants.actorId, humanId), isNull(conversationParticipants.leftAt)),
		)
		.as('mine')

	const [existing] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.innerJoin(mine, eq(mine.conversationId, conversations.id))
		.innerJoin(
			conversationParticipants,
			and(
				eq(conversationParticipants.conversationId, conversations.id),
				eq(conversationParticipants.actorId, chiefOfStaffId),
				isNull(conversationParticipants.leftAt),
			),
		)
		.where(
			and(
				eq(conversations.workspaceId, workspaceId),
				sql`(select count(*) from conversation_participants cp
					where cp.conversation_id = ${conversations.id} and cp.left_at is null) = 2`,
			),
		)
		.orderBy(desc(conversations.lastMessageAt))
		.limit(1)
	if (existing) return { conversationId: existing.id, chiefOfStaffId }

	return db.transaction(async (tx) => {
		const [created] = await tx
			.insert(conversations)
			.values({ workspaceId, title: CHAT_TITLE, createdBy: humanId })
			.returning({ id: conversations.id })
		if (!created) throw new Error('Failed to create Chief of Staff conversation')
		const participantIds = [humanId, chiefOfStaffId]
		await tx.insert(conversationParticipants).values(
			participantIds.map((actorId) => ({
				conversationId: created.id,
				actorId,
				addedBy: humanId,
			})),
		)
		await recordEvent(tx, {
			workspaceId,
			actorId: humanId,
			action: 'conversation_created',
			entityType: 'conversation',
			entityId: created.id,
			data: { participant_actor_ids: participantIds, source: 'agent_question' },
		})
		return { conversationId: created.id, chiefOfStaffId }
	})
}
