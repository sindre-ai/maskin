import type { Database } from '@maskin/db'
import {
	actors,
	conversationParticipants,
	conversations,
	messageThreadReads,
	messages,
} from '@maskin/db/schema'
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

export type ThreadParticipant = { actorId: string; actorName: string; actorType: string }

export type ThreadSummary = {
	replyCount: number
	lastReplyId: number
	lastReplyAt: string | null
	/** Replies by others newer than the caller's thread read cursor. */
	unreadCount: number
	/** Root author first, then repliers in first-reply order; at most `PARTICIPANT_LIMIT`. */
	participants: ThreadParticipant[]
}

const PARTICIPANT_LIMIT = 3

/**
 * Reply counts, unread counts and avatar stacks for a set of thread roots.
 * Roots with no replies are absent from the result.
 */
export async function loadThreadSummaries(
	db: Database,
	callerId: string,
	roots: { id: number; actorId: string }[],
): Promise<Map<number, ThreadSummary>> {
	const out = new Map<number, ThreadSummary>()
	if (roots.length === 0) return out
	const rootIds = roots.map((r) => r.id)

	const agg = await db
		.select({
			rootId: messages.threadRootId,
			replyCount: sql<number>`count(*)::int`,
			lastReplyId: sql<number>`max(${messages.id})::int`,
			lastReplyAt: sql<Date | null>`max(${messages.createdAt})`,
			unreadCount: sql<number>`count(*) FILTER (WHERE ${messages.actorId} <> ${callerId} AND ${messages.id} > COALESCE(${messageThreadReads.lastReadMessageId}, 0))::int`,
		})
		.from(messages)
		.leftJoin(
			messageThreadReads,
			and(
				eq(messageThreadReads.rootMessageId, messages.threadRootId),
				eq(messageThreadReads.actorId, callerId),
			),
		)
		.where(inArray(messages.threadRootId, rootIds))
		.groupBy(messages.threadRootId)

	const repliers = await db
		.select({
			rootId: messages.threadRootId,
			actorId: actors.id,
			actorName: actors.name,
			actorType: actors.type,
		})
		.from(messages)
		.innerJoin(actors, eq(actors.id, messages.actorId))
		.where(inArray(messages.threadRootId, rootIds))
		.orderBy(messages.id)

	const rootAuthorIds = [...new Set(roots.map((r) => r.actorId))]
	const authors = await db
		.select({ actorId: actors.id, actorName: actors.name, actorType: actors.type })
		.from(actors)
		.where(inArray(actors.id, rootAuthorIds))
	const authorById = new Map(authors.map((a) => [a.actorId, a]))

	const stacks = new Map<number, ThreadParticipant[]>()
	for (const root of roots) {
		const a = authorById.get(root.actorId)
		stacks.set(root.id, a ? [a] : [])
	}
	for (const r of repliers) {
		if (r.rootId === null) continue
		const stack = stacks.get(r.rootId)
		if (!stack || stack.length >= PARTICIPANT_LIMIT) continue
		if (stack.some((p) => p.actorId === r.actorId)) continue
		stack.push({ actorId: r.actorId, actorName: r.actorName, actorType: r.actorType })
	}

	for (const a of agg) {
		if (a.rootId === null) continue
		const last = a.lastReplyAt ? new Date(a.lastReplyAt) : null
		out.set(a.rootId, {
			replyCount: a.replyCount,
			lastReplyId: a.lastReplyId,
			lastReplyAt: last ? last.toISOString() : null,
			unreadCount: a.unreadCount,
			participants: stacks.get(a.rootId) ?? [],
		})
	}
	return out
}

/**
 * Root ids of the threads the caller is in — they wrote the root or replied to
 * it — across conversations they are an active participant of in the workspace,
 * most recently active first.
 */
export async function listCallerThreadRootIds(
	db: Database,
	args: { callerId: string; workspaceId: string; limit: number },
): Promise<number[]> {
	const root = alias(messages, 'root')
	const rows = await db
		.select({ rootId: messages.threadRootId })
		.from(messages)
		.innerJoin(root, eq(root.id, messages.threadRootId))
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.innerJoin(
			conversationParticipants,
			and(
				eq(conversationParticipants.conversationId, conversations.id),
				eq(conversationParticipants.actorId, args.callerId),
				isNull(conversationParticipants.leftAt),
			),
		)
		.where(and(eq(conversations.workspaceId, args.workspaceId), isNotNull(messages.threadRootId)))
		.groupBy(messages.threadRootId, root.actorId)
		.having(
			sql`bool_or(${messages.actorId} = ${args.callerId}) OR ${root.actorId} = ${args.callerId}`,
		)
		.orderBy(desc(sql`max(${messages.id})`))
		.limit(args.limit)
	return rows.flatMap((r) => (r.rootId === null ? [] : [r.rootId]))
}
