// Helpers for focusing a specific card in the For You feed. The queue uses a
// `<entity_type>:<entity_id>` composite key (see itemQueueKey in
// foryou-queue-card.tsx) — this module keeps the encode/parse in one place
// so the push-notification deep-link, the URL search param, and the queue
// prop all speak exactly the same shape.

export interface ParsedForYouCardKey {
	entityType: string
	entityId: string
}

export function encodeForYouCardKey(entityType: string, entityId: string): string {
	return `${entityType}:${entityId}`
}

// Parses `<entity_type>:<entity_id>` back into its parts, or returns null if
// the input is empty, missing the separator, or has an empty side.
export function parseForYouCardKey(key: string | null | undefined): ParsedForYouCardKey | null {
	if (!key) return null
	const idx = key.indexOf(':')
	if (idx <= 0 || idx >= key.length - 1) return null
	return {
		entityType: key.slice(0, idx),
		entityId: key.slice(idx + 1),
	}
}

function extractWorkspaceId(pathname: string): string | null {
	const segments = pathname.split('/').filter(Boolean)
	return segments[0] ?? null
}

// Routes the current window to the For You feed with the target card focused
// via `?card=<entity_type>:<entity_id>`. Uses pushState + a synthetic popstate
// so TanStack Router picks up the new URL when the app is already mounted;
// pre-mount callers (main.tsx boot) get the same URL in place before the
// router's first render, so this covers both the cold-start and warm-state
// notification-tap paths in one path.
export function navigateToForYouCard(entityType: string, entityId: string): void {
	const card = encodeForYouCardKey(entityType, entityId)
	const url = new URL(window.location.href)
	const workspaceId = extractWorkspaceId(url.pathname)
	if (workspaceId) {
		url.pathname = `/${workspaceId}/`
	}
	url.searchParams.set('card', card)
	const target = url.pathname + url.search
	if (target === window.location.pathname + window.location.search) return
	history.pushState(null, '', target)
	window.dispatchEvent(new PopStateEvent('popstate'))
}
