import type { Database } from '@maskin/db'
import { actors, messages } from '@maskin/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { LiveCredentials } from '../lib/live-credentials'
import { OpenAIAdapter } from '../lib/llm/openai'
import { logger } from '../lib/logger'
import { captureLiveException } from '../lib/sentry-live'
import { insertConversationMessage } from './conversation-messages'
import type { LiveSessionRow } from './live-session-lifecycle'
import { isLiveTranscriptEnabled } from './live-transcript'

/**
 * After a call, the agent leaves short notes in the chat: what was decided, what
 * it did, what is still open. The design handoff says ending a call "posts the
 * notes into the chat". One non-streamed completion over this call's own lines;
 * best effort, so a failure here never affects a call that has already ended.
 */

const MIN_USER_TURNS = 2
const MAX_LINES = 60
const NOTES_TIMEOUT_MS = 25_000

export const CLOSING_NOTES_SYSTEM = [
	'You write the short notes an agent leaves in the chat after a voice call.',
	'Write 2 to 5 plain bullet points covering, in this order of importance: decisions the person made, things you did or changed, and what is still open or needs them.',
	'Use names and titles, never ids. No greeting, no sign-off, no summary of small talk.',
	'If nothing was decided, done or left open, reply with exactly: NONE',
].join('\n')

interface CallLine {
	actorId: string
	actorName: string
	content: string
}

/** Builds the transcript the notes are written from. Pure, for testing. */
export function formatCallTranscript(lines: CallLine[], agentId: string): string {
	return lines.map((l) => `${l.actorId === agentId ? 'You' : l.actorName}: ${l.content}`).join('\n')
}

/** True when a call was long enough to be worth notes. */
export function callWarrantsNotes(lines: CallLine[], agentId: string): boolean {
	return lines.filter((l) => l.actorId !== agentId).length >= MIN_USER_TURNS
}

export type NotesCompletion = (p: { system: string; transcript: string }) => Promise<string | null>

export function defaultNotesCompletion(creds: LiveCredentials): NotesCompletion {
	const adapter = new OpenAIAdapter(
		creds.apiKey,
		creds.baseUrl,
		creds.providerPrefs ? { provider: creds.providerPrefs } : undefined,
	)
	return async ({ system, transcript }) => {
		const res = await Promise.race([
			adapter.chat({
				model: creds.llmModel,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: `Here is the call.\n\n${transcript}` },
				],
				max_tokens: 400,
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('closing notes timed out')), NOTES_TIMEOUT_MS).unref(),
			),
		])
		return res.content
	}
}

export async function writeClosingNotes(a: {
	db: Database
	session: Pick<
		LiveSessionRow,
		'id' | 'workspaceId' | 'agentActorId' | 'conversationId' | 'inputMode'
	>
	complete: NotesCompletion
}): Promise<{ messageId: number } | null> {
	const { db, session } = a
	try {
		if (!session.conversationId) return null
		if (!(await isLiveTranscriptEnabled(db, session.workspaceId))) return null

		const lines = await db
			.select({ actorId: messages.actorId, actorName: actors.name, content: messages.content })
			.from(messages)
			.innerJoin(actors, eq(actors.id, messages.actorId))
			.where(
				and(
					eq(messages.conversationId, session.conversationId),
					eq(messages.kind, 'message'),
					sql`${messages.metadata}->>'live_session_id' = ${session.id}`,
				),
			)
			.orderBy(asc(messages.id))
			.limit(MAX_LINES)
		if (!callWarrantsNotes(lines, session.agentActorId)) return null

		const text = (
			await a.complete({
				system: CLOSING_NOTES_SYSTEM,
				transcript: formatCallTranscript(lines, session.agentActorId),
			})
		)?.trim()
		if (!text || /^none\b/i.test(text)) return null

		const row = await insertConversationMessage(db, {
			conversationId: session.conversationId,
			workspaceId: session.workspaceId,
			actorId: session.agentActorId,
			content: text,
			metadata: {
				source: 'live',
				live_session_id: session.id,
				live: {
					turn_index: lines.length,
					input_mode: session.inputMode === 'text' ? 'text' : 'audio',
					interrupted: false,
				},
			},
			sessionId: null,
		})
		return row ? { messageId: row.id } : null
	} catch (err) {
		logger.warn('live closing notes failed', {
			live_session_id: session.id,
			error: err instanceof Error ? err.message : String(err),
		})
		captureLiveException(session.id, err)
		return null
	}
}
