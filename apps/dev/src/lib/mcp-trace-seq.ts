// Per-session sequence numbers for MCP tool-call traces.
//
// Why a counter instead of sorting by timestamp: trace events are emitted
// fire-and-forget (PostHog capture is an un-awaited fetch), so two calls a few
// milliseconds apart can be ingested out of order and `createdAt` cannot be
// trusted to reconstruct call order. A monotonic integer stamped at the moment
// the call is observed can be — sort by `seq` and you have the exact order the
// agent invoked the tools in.
//
// Caveat, deliberately accepted: the counter lives in this process. apps/dev
// runs as a single app container today, so every request for a given session
// hits the same counter. If that ever becomes multiple replicas, a session
// whose calls land on different replicas would restart its numbering — which
// is why every event also carries `ts_ms` as a coarse tiebreak.

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000 // 6h — longer than any agent session
const DEFAULT_MAX_SESSIONS = 10_000

export interface SeqCounter {
	/** Returns the next 1-based sequence number for `sessionId`. */
	next(sessionId: string): number
	/** Number of sessions currently tracked — for tests and diagnostics. */
	size(): number
	/** Drops all tracked sessions. Used by tests to isolate cases. */
	reset(): void
}

export interface SeqCounterOptions {
	ttlMs?: number
	maxSessions?: number
	/** Injectable clock so tests can advance time without waiting. */
	now?: () => number
}

export function createSeqCounter(options: SeqCounterOptions = {}): SeqCounter {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
	const now = options.now ?? Date.now
	const entries = new Map<string, { n: number; lastSeen: number }>()

	// Drop sessions we haven't seen inside the TTL. Called on every `next()`
	// only when the map has grown past the cap, so the common path stays O(1);
	// the sweep itself is O(n) but runs rarely and against a bounded map.
	const sweep = (cutoff: number) => {
		for (const [key, entry] of entries) {
			if (entry.lastSeen < cutoff) entries.delete(key)
		}
	}

	return {
		next(sessionId: string): number {
			const t = now()
			if (entries.size >= maxSessions) {
				sweep(t - ttlMs)
				// Still over the cap after sweeping (a burst of live sessions, not
				// stale ones): evict oldest-inserted first. Map preserves insertion
				// order, so the first key is the least recently created entry.
				while (entries.size >= maxSessions) {
					const oldest = entries.keys().next()
					if (oldest.done) break
					entries.delete(oldest.value)
				}
			}
			const existing = entries.get(sessionId)
			// An entry older than the TTL is treated as a new session rather than
			// resuming a stale count — a reused session id after hours of silence
			// is a different conversation.
			if (existing && t - existing.lastSeen < ttlMs) {
				existing.n += 1
				existing.lastSeen = t
				return existing.n
			}
			entries.set(sessionId, { n: 1, lastSeen: t })
			return 1
		},
		size(): number {
			return entries.size
		},
		reset(): void {
			entries.clear()
		},
	}
}
