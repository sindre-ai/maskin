import type { NotificationResponse } from '@/lib/api'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Metadata keys ending in _id that are NOT object references. */
const NON_OBJECT_ID_KEYS = new Set(['source_actor_id', 'target_actor_id', 'session_id'])

/** Extract all referenced object IDs from a notification (objectId + metadata _id fields). */
export function extractNotificationObjectIds(notification: NotificationResponse): string[] {
	const ids = new Set<string>()
	if (notification.objectId && UUID_RE.test(notification.objectId)) {
		ids.add(notification.objectId)
	}
	const metadata = notification.metadata ?? {}
	for (const [key, value] of Object.entries(metadata)) {
		if (NON_OBJECT_ID_KEYS.has(key)) continue
		if (typeof value === 'string' && key.endsWith('_id') && UUID_RE.test(value)) {
			ids.add(value)
		}
	}
	return Array.from(ids)
}

export interface NavigationTarget {
	path: string
	search?: Record<string, string>
}

export function resolveNavigationTarget(
	workspaceId: string,
	nav: { to: string; id?: string },
	notification: NotificationResponse,
): NavigationTarget | null {
	const id = nav.id && UUID_RE.test(nav.id) ? nav.id : undefined
	switch (nav.to) {
		case 'object': {
			const fallbackId =
				notification.objectId && UUID_RE.test(notification.objectId)
					? notification.objectId
					: undefined
			const objectId = id ?? fallbackId
			return { path: objectId ? `/${workspaceId}/objects/${objectId}` : `/${workspaceId}/objects` }
		}
		case 'objects': {
			const objectIds = extractNotificationObjectIds(notification)
			if (objectIds.length > 0) {
				return { path: `/${workspaceId}/objects`, search: { ids: objectIds.join(',') } }
			}
			return { path: `/${workspaceId}/objects` }
		}
		case 'activity':
			return { path: `/${workspaceId}/activity` }
		case 'agent':
			return id ? { path: `/${workspaceId}/agents/${id}` } : null
		case 'trigger':
			return id ? { path: `/${workspaceId}/triggers/${id}` } : null
		default:
			return null
	}
}

/** @deprecated Use resolveNavigationTarget instead */
export function resolveNavigationPath(
	workspaceId: string,
	nav: { to: string; id?: string },
	notification: NotificationResponse,
): string | null {
	const target = resolveNavigationTarget(workspaceId, nav, notification)
	return target?.path ?? null
}
