import type { Database } from '@maskin/db'
import { logger } from '../lib/logger'
import { type AppendedComment, appendCommentEvent } from './comments'
import type { SessionManager } from './session-manager'

// Scan at most this many lines from the tail of stdout — the stream-json
// `result` envelope is always the last line, and concatenated `assistant`
// text blocks for a single turn fit comfortably in this window.
const MAX_LINES_SCANNED = 500

/**
 * Pure parser: extract the final assistant reply text from the captured
 * stdout tail of a Claude Code stream-json session.
 *
 * Preference order:
 *   1. The `result` envelope's `.result` string. The CLI writes the entire
 *      final text here at turn end, which is the cleanest source of truth.
 *   2. If `result.result` is missing or empty (e.g. CLI quirks, runtime
 *      didn't reach the result envelope), fall back to concatenating every
 *      `text` block across all `assistant` envelopes in arrival order so a
 *      mid-stream cut-off still persists what was finalized.
 *
 * Returns `null` when nothing usable is in the tail — e.g. Codex / custom
 * runtimes that don't emit stream-json, or a failed session that never
 * produced an assistant message. The writer treats `null` as "nothing to
 * persist" so we never write an empty agent reply onto the transcript.
 */
export function parseAgentReplyFromLogChunks(chunks: string[]): string | null {
	if (chunks.length === 0) return null
	const lines = chunks.join('').split('\n')
	const start = Math.max(0, lines.length - MAX_LINES_SCANNED)

	let resultText: string | null = null
	const assistantTexts: string[] = []

	for (let i = start; i < lines.length; i++) {
		const line = lines[i]?.trim()
		if (!line || line[0] !== '{') continue
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch {
			continue
		}
		if (!parsed || typeof parsed !== 'object') continue
		const obj = parsed as Record<string, unknown>
		const type = obj.type

		if (type === 'result') {
			// Only honor a successful result; an error result has no user-facing
			// reply text worth persisting. The last successful result wins.
			if (obj.is_error === true) continue
			const text = obj.result
			if (typeof text === 'string' && text.trim().length > 0) {
				resultText = text
			}
		} else if (type === 'assistant') {
			const message = obj.message
			if (!message || typeof message !== 'object') continue
			const content = (message as Record<string, unknown>).content
			if (!Array.isArray(content)) continue
			for (const block of content) {
				if (!block || typeof block !== 'object') continue
				const b = block as Record<string, unknown>
				if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
					assistantTexts.push(b.text)
				}
			}
		}
	}

	if (resultText !== null) return resultText
	if (assistantTexts.length === 0) return null
	const joined = assistantTexts.join('\n\n').trim()
	return joined.length > 0 ? joined : null
}

export interface PersistAgentChatReplyInput {
	db: Database
	sessionManager: SessionManager
	workspaceId: string
	actorId: string
	conversationId: string
	logChunks: string[]
	/**
	 * Optional thread-root events.id. When set, the appended reply is written
	 * as a threaded `commented` event under this parent — same path the
	 * conversation route uses for user-authored thread replies. `appendCommentEvent`
	 * collapses multi-level parents to the root, so passing any reply event in
	 * the thread is safe.
	 */
	parentEventId?: number
}

/**
 * Parse the agent reply from a completed session's stdout tail and write
 * it as a single `commented` event on the conversation object. Returns
 * the appended event when one was written, or `null` when there was
 * nothing usable to persist (e.g. the parser couldn't find a reply).
 *
 * Gated by the caller on `session.config.chat_reply?.conversation_id`,
 * so this helper never has to inspect the session row itself. The caller
 * also owns failure handling — a thrown error from here must not block
 * the surrounding session-finalization flow.
 */
export async function persistAgentChatReply(
	input: PersistAgentChatReplyInput,
): Promise<AppendedComment | null> {
	const { db, sessionManager, workspaceId, actorId, conversationId, logChunks, parentEventId } =
		input

	const replyText = parseAgentReplyFromLogChunks(logChunks)
	if (replyText === null) {
		logger.info('Skipping chat-reply persist — no assistant reply found in session tail', {
			conversationId,
			actorId,
		})
		return null
	}

	const comment = await appendCommentEvent({
		db,
		sessionManager,
		workspaceId,
		actorId,
		entityType: 'object',
		entityId: conversationId,
		content: replyText,
		...(parentEventId !== undefined ? { parentEventId } : {}),
	})

	logger.info('Persisted agent chat reply as commented event', {
		conversationId,
		actorId,
		commentEventId: comment.id,
		replyLength: replyText.length,
		...(parentEventId ? { parentEventId } : {}),
	})

	return comment
}
