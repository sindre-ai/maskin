import type { Database, Transaction } from '@maskin/db'
import { actors, conversationParticipants, notifications } from '@maskin/db/schema'
import type { MessageMetadata } from '@maskin/shared'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { type Notification, insertNotificationsWithEvents } from '../lib/notifications'

/**
 * Producers for the push notifications a chat generates. Push is driven only
 * by `notifications` rows (see NotificationPushFanout); the consumer owns
 * delay, debounce, rate limits and quiet hours. This file only creates
 * well-formed rows, once, at the right moment.
 *
 * Row contract (notifications.metadata):
 *   push_category      'needs_you' | 'conversation'
 *   push_collapse_key  `chat:<conversationId>`
 *   push_delay_seconds conversation rows only; the consumer waits, then skips
 *                      the push if the target already read up to message_id
 *   conversation_id, message_id   deep link + the read-up-to check
 */

const PREVIEW_MAX = 140

/** How long the consumer waits before pushing a plain chat reply. */
export const CHAT_REPLY_PUSH_DELAY_SECONDS = 25

/**
 * Chat replies are not inbox items: they are rows whose only job is to drive a
 * push. `push_only` keeps them out of GET /api/notifications (inbox, slash
 * picker, MCP list_notifications); the For You feed already excludes them
 * because it requires type needs_input AND metadata.kind = 'for_you'.
 */
export const PUSH_ONLY_METADATA_KEY = 'push_only'

/** First ~140 chars of a markdown message as plain text, ellipsised when cut. */
export function previewText(markdown: string, max = PREVIEW_MAX): string {
	const plain = markdown
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
		.replace(/(\*\*|__|\*|_|~~)/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

type Db = Database | Transaction

async function actorProfile(db: Db, actorId: string) {
	const [row] = await db
		.select({ name: actors.name, type: actors.type })
		.from(actors)
		.where(eq(actors.id, actorId))
		.limit(1)
	return row ?? null
}

/** Active, non-archived human participants of a conversation, minus one actor. */
export async function humanParticipants(
	db: Db,
	conversationId: string,
	excludeActorId: string,
): Promise<string[]> {
	const rows = await db
		.select({ actorId: conversationParticipants.actorId })
		.from(conversationParticipants)
		.innerJoin(actors, eq(actors.id, conversationParticipants.actorId))
		.where(
			and(
				eq(conversationParticipants.conversationId, conversationId),
				isNull(conversationParticipants.leftAt),
				eq(conversationParticipants.archived, false),
				eq(actors.type, 'human'),
				ne(conversationParticipants.actorId, excludeActorId),
			),
		)
	return rows.map((r) => r.actorId)
}

type ChatNotificationArgs = {
	workspaceId: string
	authorId: string
	conversationId: string
	messageId: number
	targets: string[]
	type: 'needs_input' | 'good_news'
	title: string
	content: string
	extraMetadata: Record<string, unknown>
	status: 'pending' | 'seen'
	objectId?: string | null
	sessionId?: string | null
}

/**
 * Inserts one notification per target for a chat message, skipping any target
 * that already has one for this message (the notifications table has no unique
 * constraint to lean on), and logs the `notification created` event that wakes
 * the push fan-out. Runs in its own transaction (a savepoint when handed one)
 * so a failure cannot abort the caller's transaction.
 */
async function createChatNotifications(
	db: Db,
	args: ChatNotificationArgs,
): Promise<Notification[]> {
	if (args.targets.length === 0) return []
	return (db as Database).transaction(async (tx) => {
		const existing = await tx
			.select({ targetActorId: notifications.targetActorId })
			.from(notifications)
			.where(
				and(
					eq(notifications.workspaceId, args.workspaceId),
					inArray(notifications.targetActorId, args.targets),
					sql`${notifications.metadata}->>'conversation_id' = ${args.conversationId}`,
					sql`${notifications.metadata}->>'message_id' = ${String(args.messageId)}`,
				),
			)
		const already = new Set(existing.map((r) => r.targetActorId))
		const targets = args.targets.filter((t) => !already.has(t))

		return insertNotificationsWithEvents(tx, {
			workspaceId: args.workspaceId,
			actorId: args.authorId,
			rows: targets.map((targetActorId) => ({
				workspaceId: args.workspaceId,
				type: args.type,
				title: args.title,
				content: args.content,
				sourceActorId: args.authorId,
				targetActorId,
				objectId: args.objectId ?? null,
				sessionId: args.sessionId ?? null,
				status: args.status,
				metadata: {
					...args.extraMetadata,
					push_collapse_key: `chat:${args.conversationId}`,
					conversation_id: args.conversationId,
					message_id: args.messageId,
				},
			})),
		})
	})
}

/**
 * An agent asked the person a question (POST /sessions/:id/ask). Best effort:
 * the question is already posted, so a failure here is logged and swallowed.
 */
export async function notifyAgentQuestion(
	db: Db,
	args: {
		workspaceId: string
		agentId: string
		conversationId: string
		messageId: number
		targets: string[]
		firstQuestion: string
		objectId?: string | null
		sessionId?: string | null
	},
): Promise<void> {
	try {
		const agent = await actorProfile(db, args.agentId)
		await createChatNotifications(db, {
			workspaceId: args.workspaceId,
			authorId: args.agentId,
			conversationId: args.conversationId,
			messageId: args.messageId,
			targets: args.targets.filter((t) => t !== args.agentId),
			type: 'needs_input',
			status: 'pending',
			title: `${agent?.name ?? 'An agent'} has a question`,
			content: previewText(args.firstQuestion),
			objectId: args.objectId,
			sessionId: args.sessionId,
			extraMetadata: { push_category: 'needs_you' },
		})
	} catch (err) {
		logger.warn('Failed to create notification for agent question', {
			conversationId: args.conversationId,
			messageId: args.messageId,
			error: String(err),
		})
	}
}

/** True for a final-output message that is a real reply, not a failure notice. */
function isSuccessfulFinalOutput(metadata: MessageMetadata | null | undefined): boolean {
	if (metadata?.source !== 'final_output') return false
	const f = metadata.final_output
	if (!f) return true
	return !(f.is_error || f.error_kind || f.retry || f.pseudo_tool_calls || f.empty_completion)
}

/**
 * An agent's auto-posted end-of-turn reply was just inserted. Called by
 * insertConversationMessage only after a fresh insert (it returns null on a
 * dedupe conflict, so a replayed log line never gets here) and only for
 * `source: 'final_output'` messages, so mid-turn/tool/step messages, human
 * messages, system messages and failure notices create nothing. Notifies every
 * other active human participant; an agent-to-agent chat has none.
 *
 * Type: the notification type enum is closed (the iOS client's generated types
 * decode it as an enum), so no new value is added. `good_news` is the neutral
 * FYI type — `alert` implies a problem and `recommendation` a decision. The
 * row is stored `seen` + `push_only` so it never counts toward the pending
 * badge or shows in the inbox; it exists to be pushed.
 *
 * Best effort: logged and swallowed, never blocks the message.
 */
export async function notifyChatReply(
	db: Db,
	msg: {
		workspaceId: string
		authorId: string
		conversationId: string
		messageId: number
		content: string
		kind: string | null | undefined
		metadata: MessageMetadata | null | undefined
		sessionId: string | null | undefined
	},
): Promise<void> {
	if ((msg.kind ?? 'message') !== 'message') return
	if (!isSuccessfulFinalOutput(msg.metadata)) return
	try {
		const author = await actorProfile(db, msg.authorId)
		if (author?.type !== 'agent') return
		const targets = await humanParticipants(db, msg.conversationId, msg.authorId)
		const asksQuestion = Boolean(msg.metadata?.question)
		await createChatNotifications(db, {
			workspaceId: msg.workspaceId,
			authorId: msg.authorId,
			conversationId: msg.conversationId,
			messageId: msg.messageId,
			targets,
			type: asksQuestion ? 'needs_input' : 'good_news',
			status: asksQuestion ? 'pending' : 'seen',
			title: author.name,
			content: previewText(msg.content),
			sessionId: msg.sessionId,
			extraMetadata: asksQuestion
				? { push_category: 'needs_you' }
				: {
						push_category: 'conversation',
						push_delay_seconds: CHAT_REPLY_PUSH_DELAY_SECONDS,
						[PUSH_ONLY_METADATA_KEY]: true,
					},
		})
	} catch (err) {
		logger.warn('Failed to create notification for chat reply', {
			conversationId: msg.conversationId,
			messageId: msg.messageId,
			error: String(err),
		})
	}
}

/**
 * The person answered in the chat: close the `needs_input` rows an agent question
 * created for them in this conversation. Without this the question keeps its
 * pending status, the "waiting on you" banner on its object and the app badge
 * until somebody resolves it by hand. A silent resolve on purpose: unlike
 * POST /notifications/:id/respond it does not wake the agent, because the chat
 * answer already reaches it.
 *
 * Only rows created by `notifyAgentQuestion` match (push_category needs_you with a
 * conversation_id and message_id) and only questions posted before this message,
 * so a later question is never closed by an earlier answer. Best effort: logged
 * and swallowed, never blocks the message.
 */
export async function resolveAnsweredQuestions(
	db: Db,
	args: { workspaceId: string; conversationId: string; answererId: string; messageId: number },
): Promise<void> {
	try {
		const resolved = await db
			.update(notifications)
			.set({ status: 'resolved', resolvedAt: new Date(), updatedAt: new Date() })
			.where(
				and(
					eq(notifications.targetActorId, args.answererId),
					eq(notifications.type, 'needs_input'),
					inArray(notifications.status, ['pending', 'seen']),
					sql`${notifications.metadata}->>'conversation_id' = ${args.conversationId}`,
					sql`${notifications.metadata}->>'push_category' = 'needs_you'`,
					sql`${notifications.metadata}->>'message_id' ~ '^[0-9]+$'`,
					sql`(${notifications.metadata}->>'message_id')::bigint < ${args.messageId}`,
				),
			)
			.returning({ id: notifications.id })
		for (const row of resolved) {
			await recordEvent(db, {
				workspaceId: args.workspaceId,
				actorId: args.answererId,
				action: 'resolved',
				entityType: 'notification',
				entityId: row.id,
				data: { reason: 'answered_in_chat', message_id: args.messageId },
			})
		}
	} catch (err) {
		logger.warn('Failed to resolve answered agent questions', {
			conversationId: args.conversationId,
			error: String(err),
		})
	}
}
