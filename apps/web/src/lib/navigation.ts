import type { NotificationResponse } from '@/lib/api'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function resolveNavigationPath(
	workspaceId: string,
	nav: { to: string; id?: string },
	notification: NotificationResponse,
): string | null {
	const id = nav.id && UUID_RE.test(nav.id) ? nav.id : undefined
	switch (nav.to) {
		case 'object': {
			const fallbackId =
				notification.objectId && UUID_RE.test(notification.objectId)
					? notification.objectId
					: undefined
			const objectId = id ?? fallbackId
			return objectId ? `/${workspaceId}/objects/${objectId}` : `/${workspaceId}/objects`
		}
		case 'objects':
			return `/${workspaceId}/objects`
		case 'activity':
			return `/${workspaceId}/activity`
		case 'agent':
			return id ? `/${workspaceId}/agents/${id}` : null
		case 'trigger':
			return id ? `/${workspaceId}/triggers/${id}` : null
		default:
			return null
	}
}
