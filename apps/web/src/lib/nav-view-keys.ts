/**
 * Mapping between TanStack Router route IDs and a coarse "view key" used to
 * persist per-view sidebar collapse state. Two routes collapse to the same key
 * when the user would want them to share collapse state (e.g. every object
 * detail page is `objects-detail`, every object list is `objects`).
 */

const HIDDEN_ROUTE_IDS = new Set(['__root__', '/_authed', '/_authed/', '/_authed/$workspaceId'])

export function isHiddenRouteId(routeId: string): boolean {
	return HIDDEN_ROUTE_IDS.has(routeId)
}

/**
 * `/_authed/$workspaceId/objects/$objectId`
 *   -> static segments `['objects']` + a param -> `objects-detail`
 * `/_authed/$workspaceId/settings/members` -> `settings-members`
 * `/_authed/$workspaceId/` (For You landing) -> `home`
 */
export function viewKeyFromRouteId(routeId: string): string | null {
	if (isHiddenRouteId(routeId)) return null
	const rest = routeId.replace(/^\/_authed\/\$workspaceId/, '')
	const segments = rest.split('/').filter(Boolean)
	let hasParam = false
	const staticSegs: string[] = []
	for (const seg of segments) {
		if (seg.startsWith('$')) hasParam = true
		else staticSegs.push(seg)
	}
	if (staticSegs.length === 0) staticSegs.push('home')
	return staticSegs.join('-') + (hasParam ? '-detail' : '')
}

export const SIDEBAR_STORAGE_PREFIX = 'maskin-sidebar-open:'

export function getStoredSidebarOpen(viewKey: string): boolean {
	try {
		const stored = localStorage.getItem(`${SIDEBAR_STORAGE_PREFIX}${viewKey}`)
		return stored === null ? true : stored === 'true'
	} catch {
		return true
	}
}

export function persistSidebarOpen(viewKey: string, value: boolean): void {
	try {
		localStorage.setItem(`${SIDEBAR_STORAGE_PREFIX}${viewKey}`, String(value))
	} catch {
		// storage may be unavailable (private mode); collapse state is best-effort
	}
}

/**
 * One-time migration: the pre-shell build stored a single global sidebar-open
 * flag under `ai-native-sidebar-open` then `maskin-sidebar-open`. Seed the
 * primary (For You) view key from that value, then remove the global keys so
 * they stop shadowing per-view state. Safe to call repeatedly.
 */
export function migrateLegacySidebarState(): void {
	try {
		const legacy =
			localStorage.getItem('ai-native-sidebar-open') ?? localStorage.getItem('maskin-sidebar-open')
		if (legacy !== null) {
			const seedKey = `${SIDEBAR_STORAGE_PREFIX}home`
			if (localStorage.getItem(seedKey) === null) {
				localStorage.setItem(seedKey, legacy)
			}
			localStorage.removeItem('ai-native-sidebar-open')
			localStorage.removeItem('maskin-sidebar-open')
		}
	} catch {
		// storage unavailable — nothing to migrate
	}
}
