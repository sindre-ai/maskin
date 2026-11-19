import type { sessions } from '@maskin/db/schema'
import { logger } from '../lib/logger'
import { type ContextEndCause, recordSessionContextSize } from '../lib/session-context-size'
import {
	type TurnSizeReading,
	classifyContextFailure,
	rotationLineTokens,
	sizeBucket,
} from '../lib/turn-size'

type SessionRow = typeof sessions.$inferSelect

/**
 * Restarts a chat that has grown too big, with a short handoff note.
 *
 * After a turn closes over the size line (or after the CLI's compaction failed or looped), the
 * chat session gets one more turn that asks for a handoff note. The note is stored on the session
 * row and the session is closed. The person's next message starts a fresh session through the
 * existing chat seed, which carries the note and the last messages.
 */

/** Switches rotation on. Off by default: the size reading and the records run either way. */
export function chatRotationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env.CHAT_ROTATION_ENABLED ?? '').trim().toLowerCase()
	return raw === '1' || raw === 'true' || raw === 'on'
}

/** First line of the handoff note. The result of the handoff turn is recognised by it. */
export const HANDOFF_MARKER = 'HANDOFF NOTE'

/** How long the handoff turn has to answer before the session is restarted without a note. */
export const HANDOFF_TIMEOUT_MS = 3 * 60_000

/** The note is kept to this many characters (about 250 words, with room to spare). */
const MAX_NOTE_CHARS = 3_000

/** The turn that asks the agent for its handoff note. */
export function buildHandoffPrompt(): string {
	return `This chat has grown large, so it will carry on in a fresh session. Write the handoff note that session will start from. Reply with the note only: no tools, no greeting, no other text. Keep it under 250 words.

Start with the line "${HANDOFF_MARKER}", then these four sections in this order:
Goal: what the person is trying to get done.
Decisions: what has been decided so far, one line each.
Standing rules: every rule or instruction the person gave that must keep holding (things not to do, things to always do), in their own words. Write "none" if there are none.
Open items: what is still to do or waiting on someone.`
}

/**
 * The note from the handoff turn's reply, or null when the reply is not a handoff note. A reply is
 * the note only if it opens with the marker line: any other result is an ordinary turn and goes
 * to the chat as usual.
 */
export function extractHandoffNote(text: string): string | null {
	const trimmed = text.trim()
	const opening = trimmed.replace(/^[\s#*_>`-]+/, '')
	if (!opening.toUpperCase().startsWith(HANDOFF_MARKER)) return null
	const note = trimmed.slice(0, MAX_NOTE_CHARS).trim()
	return note.length > 0 ? note : null
}

/** What a rotation leaves on the closed session row (config.rotation) for the next seed to read. */
export interface RotationRecord {
	reason: 'size' | 'compaction_failed'
	handoff: 'ok' | 'fallback'
	/** The handoff note; null for a fallback. Never put on an event. */
	note: string | null
	sizeBucket: string
	at: string
}

/** What rotation needs from the session manager, kept narrow so it can be tested alone. */
export interface ChatRotationHost {
	loadSession(sessionId: string): Promise<SessionRow | null>
	/** Writes the handoff turn into the session's stdin. */
	writeHandoffTurn(sessionId: string): Promise<void>
	/** True when the newest message in the chat is from someone other than the agent. */
	hasUnansweredTurn(session: SessionRow): Promise<boolean>
	/** Stores the record on the session row, closes the session and sends chat_session_rotated. */
	closeForRotation(session: SessionRow, record: RotationRecord): Promise<void>
	/** The handoff turn is over as far as the live "agent is working" signal goes. */
	handoffTurnClosed(sessionId: string): void
}

interface RotationState {
	reason: 'size' | 'compaction_failed'
	sizeBucket: string
	phase: 'requested' | 'captured'
	timer: ReturnType<typeof setTimeout> | null
}

/** True for a chat session this feature may rotate: interactive, in a conversation, not a helper. */
export function isRotatableChatSession(session: SessionRow): boolean {
	const config = (session.config ?? {}) as { stop_on_result?: unknown }
	return Boolean(session.conversationId && session.interactive && config.stop_on_result !== true)
}

export class ChatRotation {
	private readonly states = new Map<string, RotationState>()
	/** Sessions whose handoff note was just claimed: the reading of that turn is not a real turn. */
	private readonly handoffResults = new Set<string>()
	private readonly env: NodeJS.ProcessEnv
	private readonly timeoutMs: number

	constructor(
		private readonly host: ChatRotationHost,
		options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
	) {
		this.env = options.env ?? process.env
		this.timeoutMs = options.timeoutMs ?? HANDOFF_TIMEOUT_MS
	}

	/**
	 * Called after a turn of any session has closed and the chat reply (if any) is posted. Always
	 * records what the turn showed for the session-completed event; only acts when rotation is on.
	 * Never throws: a rotation fault must not break log ingest.
	 */
	async onTurn(sessionId: string, reading: TurnSizeReading): Promise<void> {
		try {
			// The handoff turn is a clean turn that says nothing about the chat: it must not wipe the
			// cause that started the rotation, and it never starts another one.
			if (this.handoffResults.delete(sessionId)) {
				recordSessionContextSize(sessionId, {
					lastTurnWindowTokens: reading.lastTurnWindowTokens,
					contextWindowTokens: reading.contextWindowTokens,
				})
				return
			}
			const cause = classifyContextFailure(reading)
			const endCause: ContextEndCause | null =
				cause === 'compaction_failed' || cause === 'context_full' ? cause : null
			recordSessionContextSize(sessionId, {
				lastTurnWindowTokens: reading.lastTurnWindowTokens,
				contextWindowTokens: reading.contextWindowTokens,
				endCause,
			})
			if (!chatRotationEnabled(this.env)) return
			const session = await this.host.loadSession(sessionId)
			if (!session || !isRotatableChatSession(session) || session.status !== 'running') return
			// Another turn may have started a rotation while the row was read.
			if (this.states.has(sessionId)) return

			let reason: 'size' | 'compaction_failed' | null = null
			if (cause === 'compaction_failed') {
				reason = 'compaction_failed'
			} else if (
				reading.lastTurnWindowTokens !== null &&
				reading.lastTurnWindowTokens >=
					rotationLineTokens(reading.contextWindowTokens, session.modelName)
			) {
				reason = 'size'
			}
			if (!reason) return

			// A message that is still unanswered is a turn in flight: ask after the next turn.
			if (await this.host.hasUnansweredTurn(session)) return

			// Set before the write: a second result line must not ask twice.
			const state: RotationState = {
				reason,
				sizeBucket: sizeBucket(reading.lastTurnWindowTokens),
				phase: 'requested',
				timer: null,
			}
			this.states.set(session.id, state)
			try {
				await this.host.writeHandoffTurn(session.id)
			} catch (err) {
				this.states.delete(session.id)
				logger.warn('Could not ask for a handoff note, keeping the session as it is', {
					sessionId: session.id,
					error: String(err),
				})
				return
			}
			state.timer = setTimeout(() => {
				void this.finish(session.id, null)
			}, this.timeoutMs)
			state.timer.unref?.()
			logger.info('Asked a big chat session for a handoff note', {
				sessionId: session.id,
				reason,
				sizeBucket: state.sizeBucket,
			})
		} catch (err) {
			logger.warn('Chat rotation check failed', { sessionId, error: String(err) })
		}
	}

	/**
	 * Called by the turn finalizer with every top-level result, before it posts it. Returns true when
	 * the result is the handoff note, so the finalizer keeps it out of the chat. Sync: the closing
	 * of the session carries on in the background.
	 */
	claimHandoffResult(sessionId: string, result: { text: string; isError: boolean }): boolean {
		const state = this.states.get(sessionId)
		if (!state || state.phase !== 'requested' || result.isError) return false
		const note = extractHandoffNote(result.text)
		if (!note) return false
		state.phase = 'captured'
		this.handoffResults.add(sessionId)
		if (state.timer) clearTimeout(state.timer)
		state.timer = null
		this.host.handoffTurnClosed(sessionId)
		void this.finish(sessionId, note)
		return true
	}

	/** Drops what is held for a session that has gone away. */
	forget(sessionId: string): void {
		const state = this.states.get(sessionId)
		if (state?.timer) clearTimeout(state.timer)
		this.states.delete(sessionId)
		this.handoffResults.delete(sessionId)
	}

	private async finish(sessionId: string, note: string | null): Promise<void> {
		const state = this.states.get(sessionId)
		if (!state) return
		if (state.timer) clearTimeout(state.timer)
		state.timer = null
		try {
			if (note === null) this.host.handoffTurnClosed(sessionId)
			const session = await this.host.loadSession(sessionId)
			if (!session || session.status !== 'running') return
			// A message that arrived while the note was written is waiting in the session: keep
			// the session and ask again after its turn.
			if (await this.host.hasUnansweredTurn(session)) {
				logger.info('A message arrived during the handoff, keeping the session', { sessionId })
				return
			}
			await this.host.closeForRotation(session, {
				reason: state.reason,
				handoff: note === null ? 'fallback' : 'ok',
				note,
				sizeBucket: state.sizeBucket,
				at: new Date().toISOString(),
			})
		} catch (err) {
			logger.warn('Chat rotation could not close the session', { sessionId, error: String(err) })
		} finally {
			this.states.delete(sessionId)
		}
	}
}
