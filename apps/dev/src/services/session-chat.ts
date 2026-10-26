import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	messages,
	sessionLogs,
	sessions,
	triggers,
} from '@maskin/db/schema'
import {
	CONVERSATION_TITLE_MAX_LENGTH,
	MESSAGE_MAX_LENGTH,
	parseResultLine,
	splitLines,
} from '@maskin/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { TERMINAL_STATUSES } from './session-lifecycle'

type SessionRow = typeof sessions.$inferSelect

/** What a run is called: its trigger's name, else the first line of its prompt. */
async function runTitle(db: Database, session: SessionRow): Promise<string> {
	if (session.triggerId) {
		const [trigger] = await db
			.select({ name: triggers.name })
			.from(triggers)
			.where(eq(triggers.id, session.triggerId))
			.limit(1)
		if (trigger?.name.trim()) return trigger.name.trim()
	}
	const firstLine = session.actionPrompt.split('\n').find((l) => l.trim().length > 0)
	return (firstLine?.trim() || 'Background run').slice(0, 80)
}

async function addParticipant(
	db: Database,
	conversationId: string,
	actorId: string,
	addedBy: string,
) {
	await db
		.insert(conversationParticipants)
		.values({ conversationId, actorId, addedBy })
		.onConflictDoUpdate({
			target: [conversationParticipants.conversationId, conversationParticipants.actorId],
			set: { leftAt: null, updatedAt: new Date() },
		})
}

/**
 * The run and every follow-up the person wrote after it ended, oldest first: one conversation,
 * as the thread view shows it.
 */
async function sessionChain(db: Database, root: SessionRow): Promise<SessionRow[]> {
	const chain = [root]
	for (;;) {
		const [next] = await db
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.workspaceId, root.workspaceId),
					sql`${sessions.config}->>'continues_session_id' = ${chain[chain.length - 1]?.id}`,
				),
			)
			.orderBy(asc(sessions.createdAt))
			.limit(1)
		if (!next || chain.some((s) => s.id === next.id)) return chain
		chain.push(next)
	}
}

const OLD_FOLLOW_UP_MARK = 'What the person says now:\n'

/** The text of a follow-up's first message: older ones wrap the person's words in a preamble. */
function followUpText(prompt: string): string {
	const at = prompt.indexOf(OLD_FOLLOW_UP_MARK)
	return (at === -1 ? prompt : prompt.slice(at + OLD_FOLLOW_UP_MARK.length)).trim()
}

/** What a person wrote into a session: a user envelope with text, not a replay or a tool echo. */
function userTurnOf(line: string): { text: string; actorId: string | null } | null {
	let envelope: unknown
	try {
		envelope = JSON.parse(line)
	} catch {
		return null
	}
	const e = envelope as {
		type?: unknown
		maskin_retry?: unknown
		maskin_actor_id?: unknown
		message?: { content?: unknown }
	}
	if (e?.type !== 'user' || e.maskin_retry === true) return null
	const content = e.message?.content
	// Written by the input route; absent on turns that were written before it was recorded.
	const actorId = typeof e.maskin_actor_id === 'string' ? e.maskin_actor_id : null
	if (typeof content === 'string') return content.trim() ? { text: content.trim(), actorId } : null
	if (!Array.isArray(content)) return null
	const text = content
		.map((b: { type?: unknown; text?: unknown }) =>
			b?.type === 'text' && typeof b.text === 'string' ? b.text : '',
		)
		.join('\n')
		.trim()
	return text ? { text, actorId } : null
}

/**
 * Puts a run into the chat as it was read: what it was asked, what the agent said, and what
 * people wrote into it, in order, each as a message from whoever wrote it.
 *
 * - The first message is the prompt when it was handed over by someone (an agent in a chat, the
 *   person who followed up). A trigger's prompt is its instructions and the event that fired it,
 *   not something anyone said, so it is left out.
 * - The agent's replies are written the way the turn finalizer writes them (same dedupe key), so
 *   a run that is still going does not post the same reply twice once it is linked.
 * - A message a person wrote into the run is credited to whoever typed it (recorded on the turn
 *   since this was added); older turns carry no author and are credited to whoever opens the chat.
 */
async function copyRunIntoChat(
	db: Database,
	chain: SessionRow[],
	conversationId: string,
	openedBy: string,
): Promise<void> {
	let last: Date | null = null
	const post = async (actorId: string, content: string, createdAt: Date, extra: object) => {
		await db.insert(messages).values({
			conversationId,
			actorId,
			content: content.slice(0, MESSAGE_MAX_LENGTH),
			createdAt,
			...extra,
		})
		last = createdAt
	}

	for (const [index, session] of chain.entries()) {
		// Who handed the work over: the one who followed up, or the agent whose message the run
		// hangs from. Neither exists for a trigger run.
		let promptBy: string | null = null
		if (index > 0) {
			promptBy = session.createdBy
		} else if (session.spawnedByMessageId !== null) {
			const [anchor] = await db
				.select({ actorId: messages.actorId })
				.from(messages)
				.where(eq(messages.id, session.spawnedByMessageId))
				.limit(1)
			promptBy = anchor?.actorId ?? null
		}
		const prompt = index > 0 ? followUpText(session.actionPrompt) : session.actionPrompt.trim()
		if (promptBy && prompt) {
			await post(promptBy, prompt, session.createdAt ?? new Date(), {
				metadata: null,
				sessionId: null,
			})
		}

		const logs = await db
			.select({ content: sessionLogs.content, createdAt: sessionLogs.createdAt })
			.from(sessionLogs)
			.where(and(eq(sessionLogs.sessionId, session.id), eq(sessionLogs.stream, 'stdout')))
			.orderBy(asc(sessionLogs.id))
		// The first user envelope is the prompt again, wrapped in the startup text.
		let sawPrompt = false
		for (const log of logs) {
			const createdAt = log.createdAt ?? new Date()
			for (const line of splitLines(log.content).lines) {
				const written = userTurnOf(line)
				if (written !== null) {
					if (!sawPrompt) sawPrompt = true
					else
						await post(written.actorId ?? openedBy, written.text, createdAt, {
							metadata: null,
							sessionId: null,
						})
					continue
				}
				const result = parseResultLine(line)
				const text = result?.text?.trim()
				if (!result || result.isError || !text) continue
				await post(session.actorId, text, createdAt, {
					sessionId: session.id,
					metadata: {
						source: 'final_output',
						final_output: {
							dedupe_key: createHash('sha256').update(result.raw).digest('hex').slice(0, 32),
							message_id: null,
							backfilled: true,
						},
					},
				})
			}
		}
	}
	if (last) {
		await db
			.update(conversations)
			.set({ lastMessageAt: last, updatedAt: new Date() })
			.where(eq(conversations.id, conversationId))
	}
}

/**
 * The chat a background run is opened in. A run has no conversation of its own, so the first
 * time someone opens it as a chat one is made, with the person and the agent in it and the run so far
 * as its messages. After that the same chat is returned.
 *
 * A run that is still going becomes that chat's session: its later replies land in the chat and
 * the person's messages go into it. One that has ended stays as it was; the next message in the
 * chat starts a new chat session with the agent, like any other chat.
 */
export async function ensureChatForSession(
	db: Database,
	session: SessionRow,
	callerId: string,
): Promise<{ conversationId: string; created: boolean }> {
	// A session that already belongs to a chat is opened there.
	if (session.conversationId) {
		return { conversationId: session.conversationId, created: false }
	}

	const linked = (session.config as { chat_conversation_id?: unknown } | null)?.chat_conversation_id
	if (typeof linked === 'string') {
		const [existing] = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(and(eq(conversations.id, linked), eq(conversations.workspaceId, session.workspaceId)))
			.limit(1)
		if (existing) {
			await addParticipant(db, existing.id, callerId, callerId)
			return { conversationId: existing.id, created: false }
		}
	}

	const title = await runTitle(db, session)
	const chain = await sessionChain(db, session)
	const newest = chain[chain.length - 1] ?? session
	// A helper a sender is waiting on keeps ending on its result, so its result can go back to it.
	const hasSender = chain.some((s) => s.spawnedBySessionId !== null)
	const stillGoing = !hasSender && !(TERMINAL_STATUSES as readonly string[]).includes(newest.status)

	const conversationId = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(conversations)
			.values({
				workspaceId: session.workspaceId,
				title: title.slice(0, CONVERSATION_TITLE_MAX_LENGTH),
				titleAutoState: 'none',
				createdBy: callerId,
			})
			.returning({ id: conversations.id })
		if (!created) throw new Error('Failed to create conversation')

		const participantIds = [...new Set([callerId, session.actorId])]
		await tx.insert(conversationParticipants).values(
			participantIds.map((actorId) => ({
				conversationId: created.id,
				actorId,
				addedBy: callerId,
			})),
		)

		await copyRunIntoChat(tx as unknown as Database, chain, created.id, callerId)

		// Remember the chat on every session of the run, so opening it again finds it.
		for (const s of chain) {
			await tx
				.update(sessions)
				.set({
					config: sql`coalesce(${sessions.config}, '{}'::jsonb) || ${JSON.stringify({
						chat_conversation_id: created.id,
					})}::jsonb`,
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, s.id))
		}

		if (stillGoing) {
			// It is now a chat session: no longer ends on its result, replies go to the chat.
			await tx
				.update(sessions)
				.set({
					conversationId: created.id,
					config: sql`coalesce(${sessions.config}, '{}'::jsonb) - 'stop_on_result'`,
					updatedAt: new Date(),
				})
				.where(eq(sessions.id, newest.id))
		}

		await recordEvent(tx, {
			workspaceId: session.workspaceId,
			actorId: callerId,
			action: 'conversation_created',
			entityType: 'conversation',
			entityId: created.id,
			data: { participant_actor_ids: participantIds, source: 'session', session_id: session.id },
		})
		return created.id
	})

	return { conversationId, created: true }
}
