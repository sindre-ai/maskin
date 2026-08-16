import type { ActorListItem, SessionResponse } from '@/lib/api'

/**
 * Recency buckets for the Chats list, ordered newest → oldest. Labels mirror
 * the locked mockup (Today / Yesterday / This week / Earlier).
 */
export type RecencyBucket = 'today' | 'yesterday' | 'this-week' | 'earlier'

export const RECENCY_BUCKETS: RecencyBucket[] = ['today', 'yesterday', 'this-week', 'earlier']

export const RECENCY_LABELS: Record<RecencyBucket, string> = {
	today: 'Today',
	yesterday: 'Yesterday',
	'this-week': 'This week',
	earlier: 'Earlier',
}

export interface ChatGroup {
	bucket: RecencyBucket
	label: string
	items: SessionResponse[]
}

const DAY_MS = 86_400_000

function startOfDay(date: Date): number {
	const d = new Date(date)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

/** Calendar-day distance from `date` to `now` (0 = same day, 1 = yesterday, …). */
function dayDistance(date: Date, now: Date): number {
	const ms = startOfDay(now) - startOfDay(date)
	return Math.max(0, Math.round(ms / DAY_MS))
}

export function getRecencyBucket(dateString: string | null, now = new Date()): RecencyBucket {
	if (!dateString) return 'earlier'
	const date = new Date(dateString)
	if (Number.isNaN(date.getTime())) return 'earlier'
	const distance = dayDistance(date, now)
	if (distance === 0) return 'today'
	if (distance === 1) return 'yesterday'
	if (distance <= 7) return 'this-week'
	return 'earlier'
}

/** Most recent update wins; falls back to creation then start time. */
export function sessionUpdatedAt(session: SessionResponse): number {
	const date = session.updatedAt ?? session.createdAt ?? session.startedAt
	return date ? new Date(date).getTime() || 0 : 0
}

export function groupSessionsByRecency(sessions: SessionResponse[], now = new Date()): ChatGroup[] {
	const byBucket: Record<RecencyBucket, SessionResponse[]> = {
		today: [],
		yesterday: [],
		'this-week': [],
		earlier: [],
	}
	for (const session of sessions) {
		const bucket = getRecencyBucket(
			session.updatedAt ?? session.createdAt ?? session.startedAt,
			now,
		)
		byBucket[bucket].push(session)
	}

	const groups: ChatGroup[] = []
	for (const bucket of RECENCY_BUCKETS) {
		const items = byBucket[bucket].sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
		if (items.length === 0) continue
		groups.push({ bucket, label: RECENCY_LABELS[bucket], items })
	}
	return groups
}

export function formatChatCountLabel(count: number): string {
	return `${count} ${count === 1 ? 'conversation' : 'conversations'}`
}

/** Row lead line derived from read-only conversation data. */
export function getChatRowSnippet(session: SessionResponse): string {
	return session.currentActivity?.trim() ?? ''
}

/**
 * True when the session's own agent is the workspace default agent — the row
 * that pins to the "PINNED · YOUR DEFAULT AGENT" group in the chats list.
 */
export function isDefaultAgentSession(
	session: SessionResponse,
	defaultAgentId: string | null | undefined,
): boolean {
	if (!defaultAgentId) return false
	return session.actorId === defaultAgentId
}

/**
 * True when the session was spun up by the workspace default agent but is now
 * running under a different specialist — the "CoS handed off" signal on
 * sibling rows in the chats list.
 */
export function wasHandedOffByDefaultAgent(
	session: SessionResponse,
	defaultAgentId: string | null | undefined,
): boolean {
	if (!defaultAgentId) return false
	if (session.actorId === defaultAgentId) return false
	return session.createdBy === defaultAgentId
}

export interface PartitionedChats {
	/** The pinned default-agent session, if there is one, newest first. */
	pinned: SessionResponse[]
	/** Recency groups over every remaining session. */
	groups: ChatGroup[]
}

/**
 * Splits the default agent's session(s) off into a pinned bucket and groups
 * everything else by recency. When there is no default agent the pinned array
 * is empty and `groups` mirrors `groupSessionsByRecency`.
 */
export function partitionChatsWithPinned(
	sessions: SessionResponse[],
	defaultAgentId: string | null | undefined,
	now = new Date(),
): PartitionedChats {
	if (!defaultAgentId) {
		return { pinned: [], groups: groupSessionsByRecency(sessions, now) }
	}
	const pinned: SessionResponse[] = []
	const rest: SessionResponse[] = []
	for (const session of sessions) {
		if (isDefaultAgentSession(session, defaultAgentId)) pinned.push(session)
		else rest.push(session)
	}
	pinned.sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
	return { pinned, groups: groupSessionsByRecency(rest, now) }
}

const SESSION_STATE_LABEL: Record<string, string> = {
	waiting: 'Queued',
	starting: 'Starting',
	running: 'Working',
	completed: 'Done',
	paused: 'Paused',
	failed: 'Failed',
	timeout: 'Timed out',
	cancelled: 'Cancelled',
}

export function sessionStateLabel(status: string): string {
	return SESSION_STATE_LABEL[status] ?? status
}

/**
 * Resolves the workspace's default agent from its settings, matching the
 * resolver in the workspace layout: honour `default_agent_id` first, then fall
 * back to an actor named "Chief of Staff". Returns null when no default agent
 * is set on this workspace.
 */
export function resolveDefaultAgent(
	actors: ActorListItem[] | undefined,
	settings: unknown,
): ActorListItem | null {
	if (!actors) return null
	const s = settings as { default_agent_id?: string | null } | undefined
	const pinnedId = s?.default_agent_id
	if (typeof pinnedId === 'string' && pinnedId.length > 0) {
		const pinned = actors.find((a) => a.id === pinnedId)
		if (pinned) return pinned
	}
	return actors.find((a) => a.type === 'agent' && a.name === 'Chief of Staff') ?? null
}
