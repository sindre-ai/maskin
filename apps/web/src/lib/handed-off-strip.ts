import type { SpawnedSession } from './api'

/**
 * Pure helpers for the chat thread `HANDED OFF` sub-agent delegation strip
 * (bet/444b-handed-off-strip). Kept separate from the components so the
 * `sessions.status` → pill mapping and the deps-clause formatter can be
 * exercised without a jsdom render — pill mapping is the strip's
 * load-bearing contract with the backend and drifts silently if untested.
 */

/**
 * Pill states the strip renders. BLOCKED and STOPPED are deliberately out of
 * scope for v1 (no runtime source today) — the mapping returns null so the
 * caller can suppress the row entirely rather than paint a pill that has no
 * design.
 */
export type StripPill = 'QUEUED' | 'WORKING' | 'DONE' | 'FAILED'

/**
 * Backend `sessions.status` value → strip pill. Any status the spec doesn't
 * enumerate (BLOCKED, STOPPED, unknown future values) returns null so the row
 * is dropped from the strip — better one missing row than a lie of a pill.
 */
export function statusToPill(status: string | null | undefined): StripPill | null {
	switch (status) {
		case 'pending':
		case 'starting':
			return 'QUEUED'
		case 'running':
			return 'WORKING'
		case 'completed':
			return 'DONE'
		case 'failed':
		case 'timeout':
			return 'FAILED'
		default:
			return null
	}
}

/**
 * Resolve a session's `depends_on_session_ids` array to the names of the
 * dependency sessions **within the same message's spawned_sessions embed**.
 * Cross-message dependencies fall back to nothing rather than an ID string —
 * the design spec's copy is `· behind Sentinel and Forge`, and a bare UUID
 * chip in there would violate the "users never see provider ids" rule from
 * the live-verification checklist as much as any provider id would.
 */
export function resolveDepNames(
	dependsOnSessionIds: readonly string[],
	sessionsInStrip: readonly SpawnedSession[],
): string[] {
	if (dependsOnSessionIds.length === 0) return []
	const byId = new Map(sessionsInStrip.map((s) => [s.id, s.actorName]))
	const names: string[] = []
	for (const id of dependsOnSessionIds) {
		const name = byId.get(id)
		if (name) names.push(name)
	}
	return names
}

/**
 * Format an English enumeration for the deps clause. Two names use "and", 3+
 * use Oxford commas — matches the spec's `· behind Sentinel and Forge` verbatim
 * on the two-item case, and reads naturally on the rare 3+ case.
 */
export function formatDepNames(names: readonly string[]): string {
	if (names.length === 0) return ''
	if (names.length === 1) return names[0]
	if (names.length === 2) return `${names[0]} and ${names[1]}`
	return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

/**
 * Extract a display string for a FAILED row's `result` payload. Sessions can
 * store a raw string, a `{ error: string }` shape, or nothing — falls back to
 * a generic sentence rather than surfacing raw JSON to the reader.
 */
export function failureText(result: unknown): string {
	if (typeof result === 'string' && result.length > 0) return result
	if (result && typeof result === 'object') {
		const record = result as Record<string, unknown>
		for (const key of ['failure_reason', 'error', 'message']) {
			const value = record[key]
			if (typeof value === 'string' && value.length > 0) return value
		}
	}
	return 'Sub-agent stopped before finishing'
}
