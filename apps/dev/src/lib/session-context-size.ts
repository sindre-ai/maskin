/**
 * What the platform has seen of a session's context size, kept in memory until the session
 * settles and its `agent_session_completed` event goes out. In memory on purpose: it is read by
 * the one process that ingests the session's output and settles it, a restart only leaves the
 * numbers off the event (PostHog reads them as absent), and nothing is written per turn.
 */

/** How a session ended on a full or failing window. Both ride on the event's stop_reason. */
export type ContextEndCause = 'context_full' | 'compaction_failed'

export interface SessionContextSize {
	/** Window size at the last model call of the last top-level turn, in tokens. */
	lastTurnWindowTokens?: number
	/** The window the session reports for its model, in tokens. */
	contextWindowTokens?: number
	/** Set while the newest turn shows the window failing, cleared by the next clean turn. */
	endCause?: ContextEndCause
}

const MAX_TRACKED = 2_000

const sizes = new Map<string, SessionContextSize>()

/** Merges a reading into a session's record. `endCause: null` clears it; absent numbers keep the old ones. */
export function recordSessionContextSize(
	sessionId: string,
	patch: {
		lastTurnWindowTokens?: number | null
		contextWindowTokens?: number | null
		endCause?: ContextEndCause | null
	},
): void {
	const next: SessionContextSize = { ...sizes.get(sessionId) }
	if (patch.lastTurnWindowTokens != null) next.lastTurnWindowTokens = patch.lastTurnWindowTokens
	if (patch.contextWindowTokens != null) next.contextWindowTokens = patch.contextWindowTokens
	if (patch.endCause === null) next.endCause = undefined
	else if (patch.endCause) next.endCause = patch.endCause
	sizes.delete(sessionId)
	sizes.set(sessionId, next)
	// Oldest first: a session that never settled cannot hold memory forever.
	while (sizes.size > MAX_TRACKED) {
		const oldest = sizes.keys().next().value
		if (oldest === undefined) break
		sizes.delete(oldest)
	}
}

export function getSessionContextSize(sessionId: string): SessionContextSize | undefined {
	return sizes.get(sessionId)
}

export function forgetSessionContextSize(sessionId: string): void {
	sizes.delete(sessionId)
}
