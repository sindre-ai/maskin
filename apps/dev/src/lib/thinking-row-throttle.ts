/**
 * Thins out the CLI's `thinking_tokens` counter rows before they reach
 * `session_logs`.
 *
 * While a model thinks, Claude Code emits one `{"type":"system",
 * "subtype":"thinking_tokens",...}` line per tick, about 50 ms apart. A
 * reasoning-heavy model (DeepSeek) produces thousands per session, which is
 * 99% of its log rows and buries the transcript. Keeping one per interval
 * leaves a pulse so chat still shows activity through a long think.
 */

/** Minimum gap between two kept counter rows of the same session. */
export const THINKING_ROW_INTERVAL_MS = 3_000

const THINKING_MARKER = '"thinking_tokens"'

function isThinkingCounterRow(content: string): boolean {
	// Cheap substring check first: this runs on every stdout line.
	if (!content.includes(THINKING_MARKER)) return false
	try {
		const obj = JSON.parse(content.trim()) as Record<string, unknown> | null
		return obj?.type === 'system' && obj?.subtype === 'thinking_tokens'
	} catch {
		// A chunk that is not exactly one JSON line (several lines, a split line)
		// is never dropped: losing a real line is worse than keeping a counter.
		return false
	}
}

export class ThinkingRowThrottle {
	private lastKeptAt = new Map<string, number>()

	/** True when `content` is a counter row that arrived too soon after the last kept one. */
	shouldDrop(sessionId: string, content: string, nowMs: number = Date.now()): boolean {
		if (!isThinkingCounterRow(content)) return false
		const last = this.lastKeptAt.get(sessionId)
		if (last !== undefined && nowMs - last < THINKING_ROW_INTERVAL_MS) return true
		this.lastKeptAt.set(sessionId, nowMs)
		return false
	}

	forget(sessionId: string): void {
		this.lastKeptAt.delete(sessionId)
	}
}

export const thinkingRowThrottle = new ThinkingRowThrottle()
