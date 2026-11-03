import { sessionTitleFromPrompt } from '@maskin/shared'
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

/** Pill colours, shared by the strip rows and the handoff cards. */
export const STRIP_PILL_CLASSES: Record<StripPill, string> = {
	QUEUED: 'bg-[var(--st-todo-bg)] text-[var(--st-todo-text)]',
	WORKING: 'bg-[var(--st-in_progress-bg)] text-[var(--st-in_progress-text)]',
	DONE: 'bg-[var(--st-active-bg)] text-[var(--st-active-text)]',
	FAILED: 'bg-destructive/10 text-destructive',
}

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

/**
 * Group a handoff lands in on the Threads pane. Reuses the strip's pill mapping
 * so a row can never be "Done" in one place and "Working" in another. A session
 * that has asked the person something is "waiting" while it is otherwise live;
 * FAILED gets its own group because a failed handoff is one a human has to act on.
 */
export type ThreadGroup = 'waiting' | 'working' | 'failed' | 'done'

export function statusToThreadGroup(
	status: string | null | undefined,
	awaiting = false,
): ThreadGroup | null {
	const pill = statusToPill(status)
	if (awaiting && (pill === 'QUEUED' || pill === 'WORKING')) return 'waiting'
	switch (pill) {
		case 'QUEUED':
		case 'WORKING':
			return 'working'
		case 'FAILED':
			return 'failed'
		case 'DONE':
			return 'done'
		default:
			return null
	}
}

const WAITING_PILL_CLASSES = 'bg-warning/15 text-warning'

/** The pill a handoff shows: the strip's, except a session waiting on the person. */
export function threadPill(
	status: string | null | undefined,
	awaiting = false,
): { label: StripPill | 'WAITING'; className: string } | null {
	const pill = statusToPill(status)
	if (!pill) return null
	if (statusToThreadGroup(status, awaiting) === 'waiting') {
		return { label: 'WAITING', className: WAITING_PILL_CLASSES }
	}
	return { label: pill, className: STRIP_PILL_CLASSES[pill] }
}

/** One-line title for a handoff, from what it was asked to do (see sessionTitleFromPrompt). */
export function handoffTitle(actionPrompt: string, actorName: string): string {
	return sessionTitleFromPrompt(actionPrompt) ?? actorName
}

/**
 * Place each handoff in the chat's timeline: keyed by the first message written
 * after its session was created, or `'end'` when nothing has been written since.
 * Messages must be oldest-first.
 */
export function groupHandoffsByNextMessage<T extends { createdAt: string | null }>(
	handoffs: readonly T[],
	messages: readonly { id: number; createdAt: string | null }[],
): Map<number | 'end', T[]> {
	const byMessage = new Map<number | 'end', T[]>()
	for (const handoff of handoffs) {
		const at = handoff.createdAt ? Date.parse(handoff.createdAt) : Number.POSITIVE_INFINITY
		const next = messages.find((m) => (m.createdAt ? Date.parse(m.createdAt) : 0) > at)
		const key = next ? next.id : 'end'
		byMessage.set(key, [...(byMessage.get(key) ?? []), handoff])
	}
	return byMessage
}
