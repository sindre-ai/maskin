import { useQuery } from '@tanstack/react-query'
import { type EventResponse, type SessionResponse, api } from '../lib/api'
import { useActiveSessionsForConversation } from './use-sessions'

const OBJECT_ENTITY_TYPES = new Set(['bet', 'task', 'insight'])
const OBJECT_ACTIONS = new Set(['created', 'updated', 'status_changed'])
const FILE_ACTIONS = new Set(['created', 'updated'])

export interface ProducedObjectItem {
	entityId: string
	entityType: string
	title: string | null
}

export interface ProducedFileItem {
	fileId: string
	name: string | null
	mimeType: string | null
	sizeBytes: number | null
}

export interface ConversationProduced {
	producedObjects: ProducedObjectItem[]
	producedFiles: ProducedFileItem[]
	totalCount: number
	isLoading: boolean
}

interface EventsWindow {
	after: string
	before: string | null
}

// Collapses per-session windows into a single aggregate range so the chat
// pane fires exactly one events fetch — the acceptance criteria requires
// "Reused across chat detail + session sheet — no duplicate fetch." Each
// session's own sheet still hits the per-session query separately (different
// after/before → different key), which is the shape the session sheet's
// `useSessionAffectedObjects` uses today.
function aggregateWindow(sessions: SessionResponse[]): EventsWindow | null {
	if (sessions.length === 0) return null
	let earliestStart: string | null = null
	let latestEnd: string | null = null
	let anyOpen = false
	for (const s of sessions) {
		if (!s.startedAt) continue
		if (!earliestStart || s.startedAt < earliestStart) earliestStart = s.startedAt
		if (!s.completedAt) {
			anyOpen = true
		} else if (!latestEnd || s.completedAt > latestEnd) {
			latestEnd = s.completedAt
		}
	}
	if (!earliestStart) return null
	// A session that never completed leaves the aggregate window open on the
	// right — a `before` filter would clip its produce-events off. Fetching an
	// open range is safe: the events endpoint is workspace-scoped and the
	// downstream filter throws away anything outside the session set anyway.
	return { after: earliestStart, before: anyOpen ? null : latestEnd }
}

function bucketByEntity(
	events: EventResponse[],
	sessionActorIds: Set<string>,
	sessionWindows: Array<{ start: string; end: string | null }>,
): { objects: ProducedObjectItem[]; files: ProducedFileItem[] } {
	// A chat's produced items are those recorded during any of its sessions'
	// lifetimes, by an actor that ran one of those sessions. That's how the
	// events-based aggregate stays faithful to "produced downstream of this
	// chat's sessions" without walking the `produced_by` edge table (which is
	// also acceptable, but the extended `useSessionAffectedObjects` hook the
	// acceptance criteria names is events-based).
	const inWindow = (createdAt: string | null): boolean => {
		if (!createdAt) return false
		return sessionWindows.some((w) => createdAt >= w.start && (!w.end || createdAt <= w.end))
	}

	const objectsMap = new Map<string, ProducedObjectItem>()
	const filesMap = new Map<string, ProducedFileItem>()

	for (const event of events) {
		if (!sessionActorIds.has(event.actorId)) continue
		if (!inWindow(event.createdAt)) continue
		const data = (event.data ?? {}) as Record<string, unknown>

		if (OBJECT_ENTITY_TYPES.has(event.entityType) && OBJECT_ACTIONS.has(event.action)) {
			if (!objectsMap.has(event.entityId)) {
				objectsMap.set(event.entityId, {
					entityId: event.entityId,
					entityType: event.entityType,
					title: (data.title as string | null) ?? null,
				})
			}
			continue
		}

		if (event.entityType === 'file' && FILE_ACTIONS.has(event.action)) {
			if (!filesMap.has(event.entityId)) {
				filesMap.set(event.entityId, {
					fileId: event.entityId,
					name: (data.name as string | null) ?? null,
					mimeType: (data.mimeType as string | null) ?? null,
					sizeBytes: (data.sizeBytes as number | null) ?? null,
				})
			}
		}
	}

	return { objects: Array.from(objectsMap.values()), files: Array.from(filesMap.values()) }
}

/**
 * Aggregates everything produced downstream of a chat's sessions — objects and
 * files, deduped and grouped for the S2 `<ProducedPane>` on chat detail
 * (bet 34706e2f-graph-nodes, task 5).
 *
 * One events fetch per chat, keyed on the aggregate window so a session sheet
 * opened for a session already in the pane hits its own per-session cache
 * without re-hitting this one.
 */
export function useConversationProduced(
	workspaceId: string,
	conversationId: string | null,
	enabled = true,
): ConversationProduced {
	const { data: sessions } = useActiveSessionsForConversation(
		workspaceId,
		enabled ? conversationId : null,
	)
	const sessionList = sessions ?? []
	const window = aggregateWindow(sessionList)
	const sessionActorIds = new Set(sessionList.map((s) => s.actorId))
	const sessionWindows = sessionList
		.filter((s) => !!s.startedAt)
		.map((s) => ({ start: s.startedAt as string, end: s.completedAt ?? null }))

	const query = useQuery({
		queryKey: ['conversations', 'produced', conversationId, window?.after, window?.before],
		queryFn: () =>
			api.events.history(workspaceId, {
				after: window?.after as string,
				...(window?.before ? { before: window.before } : {}),
				limit: '500',
			}),
		enabled: enabled && !!conversationId && !!window,
	})

	const events = query.data ?? []
	const { objects, files } = bucketByEntity(events, sessionActorIds, sessionWindows)

	return {
		producedObjects: objects,
		producedFiles: files,
		totalCount: objects.length + files.length,
		isLoading: !!window && query.isLoading,
	}
}
