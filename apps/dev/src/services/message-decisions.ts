import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversations,
	messageDecisions,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import { CHIEF_OF_STAFF_DEFAULT } from '@maskin/shared'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { decisionFeedItemSchema } from '../lib/openapi-schemas'

export type MessageDecisionState = {
	status: 'open' | 'answered' | 'withdrawn'
	forActorIds: string[]
	attention: number | null
	answerOptionIndex: number | null
	answeredBy: string | null
	answeredAt: string | null
	withdrawnReason: string | null
}

/** Where each decision card on a page of messages stands. */
export async function loadDecisionsByMessage(
	db: Database,
	messageIds: number[],
): Promise<Map<number, MessageDecisionState>> {
	const out = new Map<number, MessageDecisionState>()
	if (messageIds.length === 0) return out
	const rows = await db
		.select()
		.from(messageDecisions)
		.where(inArray(messageDecisions.messageId, messageIds))
	for (const r of rows) {
		out.set(r.messageId, {
			status: r.status as MessageDecisionState['status'],
			forActorIds: r.forActorIds,
			attention: r.attention,
			answerOptionIndex: r.answerOptionIndex,
			answeredBy: r.answeredBy,
			answeredAt: r.answeredAt?.toISOString() ?? null,
			withdrawnReason: r.withdrawnReason,
		})
	}
	return out
}

/**
 * Only the Chief of Staff curates other agents' decisions: the built-in system agent of that
 * name, in this workspace. Anyone else asking gets a 403, so agents cannot withdraw each
 * other's questions.
 */
export async function isChiefOfStaff(
	db: Database,
	workspaceId: string,
	actorId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(
			workspaceMembers,
			and(eq(workspaceMembers.actorId, actors.id), eq(workspaceMembers.workspaceId, workspaceId)),
		)
		.where(
			and(
				eq(actors.id, actorId),
				eq(actors.type, 'agent'),
				eq(actors.isSystem, true),
				eq(actors.name, CHIEF_OF_STAFF_DEFAULT.name),
			),
		)
		.limit(1)
	return Boolean(row)
}

export type DecisionFeedItem = z.infer<typeof decisionFeedItemSchema>

/**
 * Decision cards, most urgent first. For a person that is the open cards addressed to them in
 * chats they are still in; `scope: 'all'` (the Chief of Staff's view) is every card in the
 * workspace. Shared by the decisions list and by For You, so both show the same cards.
 */
export async function loadDecisionFeed(
	db: Database,
	args: {
		workspaceId: string
		callerId: string
		state: 'open' | 'answered' | 'withdrawn'
		scope: 'mine' | 'all'
		limit: number
	},
): Promise<DecisionFeedItem[]> {
	const { workspaceId, callerId, state, scope, limit } = args
	const base = db
		.select({
			messageId: messages.id,
			conversationId: conversations.id,
			conversationTitle: conversations.title,
			subjectType: conversations.subjectType,
			subjectId: conversations.subjectId,
			content: messages.content,
			metadata: messages.metadata,
			createdAt: messages.createdAt,
			authorId: actors.id,
			authorName: actors.name,
			authorType: actors.type,
			status: messageDecisions.status,
			attention: messageDecisions.attention,
			answerOptionIndex: messageDecisions.answerOptionIndex,
			answeredBy: messageDecisions.answeredBy,
			answeredAt: messageDecisions.answeredAt,
			withdrawnReason: messageDecisions.withdrawnReason,
			// Table-qualified literal SQL: a Drizzle column here renders unqualified and binds to the
			// inner alias (known-pitfalls.md, correlated subquery).
			replyCount: sql<number>`(SELECT count(*)::int FROM messages r WHERE r.thread_root_id = messages.id)`,
		})
		.from(messageDecisions)
		.innerJoin(messages, eq(messages.id, messageDecisions.messageId))
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.$dynamic()

	const where = [eq(conversations.workspaceId, workspaceId), eq(messageDecisions.status, state)]
	const rows = await (scope === 'all'
		? base.where(and(...where))
		: base
				.innerJoin(
					conversationParticipants,
					and(
						eq(conversationParticipants.conversationId, conversations.id),
						eq(conversationParticipants.actorId, callerId),
						isNull(conversationParticipants.leftAt),
					),
				)
				.where(and(...where, sql`${callerId}::uuid = ANY(${messageDecisions.forActorIds})`))
	)
		.orderBy(sql`${messageDecisions.attention} DESC NULLS LAST`, desc(messages.id))
		.limit(limit)

	return rows.flatMap((r) => {
		const decision = (r.metadata as { decision?: unknown } | null)?.decision
		if (!decision) return []
		return [
			{
				message_id: r.messageId,
				conversation_id: r.conversationId,
				conversation_title: r.conversationTitle,
				object_id: r.subjectType === 'object' ? r.subjectId : null,
				content: r.content,
				decision,
				attention: r.attention,
				status: r.status as 'open' | 'answered' | 'withdrawn',
				withdrawn_reason: r.withdrawnReason,
				created_at: r.createdAt?.toISOString() ?? null,
				posted_by: { id: r.authorId, name: r.authorName, type: r.authorType },
				reply_count: r.replyCount,
				answer:
					r.answerOptionIndex === null
						? null
						: {
								option_index: r.answerOptionIndex,
								answered_by: r.answeredBy,
								answered_at: r.answeredAt?.toISOString() ?? null,
							},
			},
		]
	}) as DecisionFeedItem[]
}
