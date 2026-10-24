import type { Database, Transaction } from '@maskin/db'
import { actors, conversationParticipants, messages, workspaceMembers } from '@maskin/db/schema'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import {
	trackAgentChatMessageRefused,
	trackAgentChatStartedMessage,
} from '../lib/analytics/capability-events'
import { findChiefOfStaffId } from '../lib/chief-of-staff'
import { recordEvent } from '../lib/events/record-event'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { logger } from '../lib/logger'
import { findDirectChat, postToDirectChat } from './direct-chat'

/**
 * The only way an agent-authored message reaches a human it was not replying
 * to. Every rule is enforced here, in code, not in a prompt. In v1 nothing but
 * the capability digest calls it and only Chief of Staff may send.
 */

/** Fixed in v1. No workspace setting overrides them and there is no per-week person cap. */
export const PROACTIVE_LIMITS = {
	/** From one agent to one person, per 24 hours. */
	agentPerDay: 1,
	/** To one person from all agents together, per 24 hours. */
	personPerDay: 2,
	/** To one person for one reason, per 7 days. */
	reasonPerWeek: 1,
} as const

export const PROACTIVE_CONTENT_MAX = 1500
export const PROACTIVE_DELIVERY_KIND = 'proactive'
export const PROACTIVE_DELIVERY_VERSION = 1

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/**
 * A person's reply that switches proactive notes off or back on. Exact word,
 * case-insensitive, trimmed, trailing . or ! allowed. Code decides, no model.
 */
const OPT_OUT_REPLY = '^\\s*(stop|start)\\s*[.!]*\\s*$'

export type ProactiveRefusal =
	| 'flag_off'
	| 'sender_not_allowed'
	| 'sender_paused'
	| 'recipient_not_member'
	| 'no_direct_chat'
	| 'opted_out'
	| 'duplicate'
	| 'cap_agent_day'
	| 'cap_person_day'
	| 'cap_reason_week'
	| 'unread_backlog'
	| 'invalid_content'

export interface SendProactiveMessageArgs {
	workspaceId: string
	senderAgentId: string
	recipientHumanId: string
	/** Why the agent is speaking first, e.g. capability_note. Caps and analytics key on it. */
	reason: string
	content: string
	dedupeKey: string
}

export type SendProactiveMessageResult =
	| { sent: true; conversationId: string; messageId: number }
	| { sent: false; reason: ProactiveRefusal }

type Tx = Transaction

export async function sendProactiveMessage(
	db: Database,
	args: SendProactiveMessageArgs,
): Promise<SendProactiveMessageResult> {
	const outcome = await db.transaction(async (tx) => {
		// The person lock comes first; the direct-chat pair lock (sibling bet) is
		// only ever taken second and only on create paths, so lock order is fixed.
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${args.workspaceId}::text || ':proactive:' || ${args.recipientHumanId}::text))`,
		)
		return runChecksAndSend(tx, args)
	})

	if (outcome.result.sent) {
		await trackAgentChatStartedMessage({
			agent_id: args.senderAgentId,
			human_id: args.recipientHumanId,
			conversation_id: outcome.result.conversationId,
			reason: args.reason,
			hours_since_last_message: outcome.hoursSinceLastMessage,
		}).catch(logCaptureFailure('agent_chat_started_message', args))
	} else {
		await trackAgentChatMessageRefused(args.senderAgentId, outcome.result.reason).catch(
			logCaptureFailure('agent_chat_message_refused', args),
		)
	}
	return outcome.result
}

function logCaptureFailure(event: string, args: SendProactiveMessageArgs) {
	return (err: unknown) =>
		logger.warn(`${event} capture failed`, {
			workspaceId: args.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
}

function refuse(reason: ProactiveRefusal) {
	return { result: { sent: false, reason } as const, hoursSinceLastMessage: null }
}

/**
 * Whether this person has told the agent to stop in this 1-1. Derived from
 * their own messages, nothing is stored: the newest stop or start they wrote
 * after the first proactive note wins, and a stop wins. A stop typed before any
 * note was sent never counts. Only the recipient's messages are read.
 *
 * Scope is this 1-1. While only Chief of Staff can send that is the person;
 * when other agents may send it has to become a person-wide stored flag.
 */
export async function isOptedOut(
	db: Database | Tx,
	p: { conversationId: string; recipientHumanId: string },
): Promise<boolean> {
	const rows = (await db.execute(sql`
		SELECT m.content
		FROM messages m
		WHERE m.conversation_id = ${p.conversationId}
			AND m.actor_id = ${p.recipientHumanId}
			AND m.id > (
				SELECT min(f.id) FROM messages f
				WHERE f.conversation_id = ${p.conversationId}
					AND f.metadata->'delivery'->>'kind' = ${PROACTIVE_DELIVERY_KIND}
			)
			AND m.content ~* ${OPT_OUT_REPLY}
		ORDER BY m.id DESC
		LIMIT 1
	`)) as unknown as Array<{ content: string }>
	return rows[0]?.content.trim().toLowerCase().startsWith('stop') ?? false
}

/** Counts proactive messages as the caps define them. Reads the delivery marker, never content. */
const isProactive = sql`${messages.metadata}->'delivery'->>'kind' = ${PROACTIVE_DELIVERY_KIND}`

/**
 * Proactive messages that reached this person from any agent in the workspace
 * since a time, optionally for one reason. Joins through the person's active
 * participant rows (conversation_participants_actor_active_idx).
 */
async function countProactiveToPerson(
	tx: Tx,
	p: { workspaceId: string; recipientHumanId: string; since: Date; reason?: string },
): Promise<number> {
	const rows = (await tx.execute(sql`
		SELECT count(*)::int AS n
		FROM messages m
		JOIN conversations c ON c.id = m.conversation_id AND c.workspace_id = ${p.workspaceId}
		JOIN conversation_participants cp
			ON cp.conversation_id = m.conversation_id
			AND cp.actor_id = ${p.recipientHumanId}
			AND cp.left_at IS NULL
		WHERE m.metadata->'delivery'->>'kind' = ${PROACTIVE_DELIVERY_KIND}
			AND m.actor_id <> ${p.recipientHumanId}
			AND m.created_at >= ${p.since.toISOString()}::timestamptz
			${p.reason ? sql`AND m.metadata->'delivery'->>'reason' = ${p.reason}` : sql``}
	`)) as unknown as Array<{ n: number }>
	return rows[0]?.n ?? 0
}

async function runChecksAndSend(
	tx: Tx,
	args: SendProactiveMessageArgs,
): Promise<{ result: SendProactiveMessageResult; hoursSinceLastMessage: number | null }> {
	const { workspaceId, senderAgentId, recipientHumanId, reason, content, dedupeKey } = args
	const now = Date.now()

	// 1. The flag is read on the recipient.
	if (!isFlagEnabled(recipientHumanId, FLAGS.AGENT_PROACTIVE_1_1)) return refuse('flag_off')

	// 2. Only the workspace's Chief of Staff may speak first in v1.
	if ((await findChiefOfStaffId(tx, workspaceId)) !== senderAgentId) {
		return refuse('sender_not_allowed')
	}

	// 3. A paused sender is refused. The idle watcher also writes paused, so this
	// can refuse spuriously; it fails closed and the next daily tick retries.
	const [sender] = await tx
		.select({ agentState: actors.agentState })
		.from(actors)
		.where(eq(actors.id, senderAgentId))
		.limit(1)
	if (!sender || sender.agentState === 'paused') return refuse('sender_paused')

	// 4. The recipient is a human and an active member of the workspace.
	const [recipient] = await tx
		.select({ id: actors.id })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.actorId, recipientHumanId),
				eq(actors.type, 'human'),
			),
		)
		.limit(1)
	if (!recipient) return refuse('recipient_not_member')

	// 5. Find the 1-1. Never created in v1.
	const chat = await findDirectChat(tx, {
		workspaceId,
		humanId: recipientHumanId,
		agentId: senderAgentId,
	})
	if (!chat) return refuse('no_direct_chat')

	// 6. A person who replied stop is not messaged again, whatever the reason.
	if (await isOptedOut(tx, { conversationId: chat.id, recipientHumanId })) {
		return refuse('opted_out')
	}

	// 7. The same dedupe key never sends twice.
	const [dup] = await tx
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, chat.id),
				sql`${messages.metadata}->'delivery'->>'dedupe_key' = ${dedupeKey}`,
			),
		)
		.limit(1)
	if (dup) return refuse('duplicate')

	// 8. Caps. One from this sender per day.
	const dayAgo = new Date(now - DAY_MS)
	const [fromAgent] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, chat.id),
				eq(messages.actorId, senderAgentId),
				isProactive,
				gte(messages.createdAt, dayAgo),
			),
		)
	if ((fromAgent?.n ?? 0) >= PROACTIVE_LIMITS.agentPerDay) return refuse('cap_agent_day')

	// 9. Two per person per day from all agents, one per reason per week.
	const person = { workspaceId, recipientHumanId }
	if (
		(await countProactiveToPerson(tx, { ...person, since: dayAgo })) >=
		PROACTIVE_LIMITS.personPerDay
	) {
		return refuse('cap_person_day')
	}
	const weekAgo = new Date(now - WEEK_MS)
	if (
		(await countProactiveToPerson(tx, { ...person, since: weekAgo, reason })) >=
		PROACTIVE_LIMITS.reasonPerWeek
	) {
		return refuse('cap_reason_week')
	}

	// 10. The sender's last proactive message to this person must have been read.
	const [lastProactive] = await tx
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(eq(messages.conversationId, chat.id), eq(messages.actorId, senderAgentId), isProactive),
		)
		.orderBy(desc(messages.id))
		.limit(1)
	if (lastProactive) {
		const [state] = await tx
			.select({ lastRead: conversationParticipants.lastReadMessageId })
			.from(conversationParticipants)
			.where(
				and(
					eq(conversationParticipants.conversationId, chat.id),
					eq(conversationParticipants.actorId, recipientHumanId),
				),
			)
			.limit(1)
		if ((state?.lastRead ?? 0) < lastProactive.id) return refuse('unread_backlog')
	}

	// 11. 1 to 1,500 characters. No mentions metadata is ever attached below.
	if (content.length < 1 || content.length > PROACTIVE_CONTENT_MAX) {
		return refuse('invalid_content')
	}

	// 12. Store it through the shared chat port. evaluateAndRespond is never called.
	const [latest] = await tx
		.select({ createdAt: messages.createdAt })
		.from(messages)
		.where(eq(messages.conversationId, chat.id))
		.orderBy(desc(messages.id))
		.limit(1)
	const created = await postToDirectChat(tx, {
		conversationId: chat.id,
		workspaceId,
		agentId: senderAgentId,
		content,
		delivery: {
			kind: PROACTIVE_DELIVERY_KIND,
			reason,
			dedupe_key: dedupeKey,
			version: PROACTIVE_DELIVERY_VERSION,
		},
	})
	await recordEvent(tx, {
		workspaceId,
		actorId: senderAgentId,
		action: 'proactive_message_sent',
		entityType: 'conversation',
		entityId: chat.id,
		data: { message_id: created.id, recipient_id: recipientHumanId, reason, dedupe_key: dedupeKey },
	})

	const hoursSinceLastMessage = latest?.createdAt
		? Math.round(((now - latest.createdAt.getTime()) / 3_600_000) * 10) / 10
		: null
	return {
		result: { sent: true, conversationId: chat.id, messageId: created.id },
		hoursSinceLastMessage,
	}
}
