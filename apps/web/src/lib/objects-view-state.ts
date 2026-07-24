// Session-scoped view-state store for the Objects list route. Holds the
// per-tab state that a silent back-nav restore needs to rehydrate: which
// groups were expanded and which row was at the top of the viewport. Keyed
// by `${workspaceId}::${displaySettingsKey}` so the All tab and each type
// tab keep their own slot and never leak state across each other.
//
// In-memory only. `sessionStorage` would survive tab crashes and reloads
// (off-spec per the bet's `## Not doing`); `localStorage` would leak across
// tabs. A module-level Map dies with the page context, which is what the
// bet wants.

export interface ObjectsViewStateSnapshot {
	expandedGroupIds: Record<string, boolean>
	firstVisibleRowId: string | null
}

const EMPTY: ObjectsViewStateSnapshot = { expandedGroupIds: {}, firstVisibleRowId: null }

const store = new Map<string, ObjectsViewStateSnapshot>()

function makeKey(workspaceId: string, displaySettingsKey: string): string {
	return `${workspaceId}::${displaySettingsKey}`
}

export function getViewState(
	workspaceId: string,
	displaySettingsKey: string,
): ObjectsViewStateSnapshot {
	return store.get(makeKey(workspaceId, displaySettingsKey)) ?? EMPTY
}

export function setViewState(
	workspaceId: string,
	displaySettingsKey: string,
	next: ObjectsViewStateSnapshot,
): void {
	store.set(makeKey(workspaceId, displaySettingsKey), next)
}

export function patchViewState(
	workspaceId: string,
	displaySettingsKey: string,
	patch: Partial<ObjectsViewStateSnapshot>,
): void {
	const current = getViewState(workspaceId, displaySettingsKey)
	setViewState(workspaceId, displaySettingsKey, { ...current, ...patch })
}

export function clearViewState(workspaceId: string, displaySettingsKey: string): void {
	store.delete(makeKey(workspaceId, displaySettingsKey))
}

export function __resetObjectsViewStateForTesting(): void {
	store.clear()
}
