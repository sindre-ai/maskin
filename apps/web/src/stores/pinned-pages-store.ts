import {
	getPinnedPageIds,
	setPinnedPageIds as writePinnedPageIdsToStorage,
} from '@/lib/pinned-pages'

// Shared client store for pinned page IDs, scoped per workspace.
//
// Why this exists: the previous implementation kept `pinnedIds` in each
// `usePinnedPages` consumer's local `useState`, so two consumers (sidebar +
// `/$workspaceId/pages`) held independent copies. Pinning from the grid would
// not update the sidebar until remount/refresh. This module is the single
// source of truth that all consumers subscribe to via `useSyncExternalStore`.
//
// The store also serves as the seam for the server-sync follow-up (task
// 7ae2c9e1): the localStorage write-through stays inside this module so that
// adding a server fetch on hydration and a server PUT on write only touches
// this file, not every caller.

type Listener = () => void

const snapshots = new Map<string, string[]>()
const listeners = new Set<Listener>()
const STORAGE_KEY_PREFIX = 'maskin-pinned-pages-'

function read(workspaceId: string): string[] {
	const cached = snapshots.get(workspaceId)
	if (cached) return cached
	const fresh = getPinnedPageIds(workspaceId)
	snapshots.set(workspaceId, fresh)
	return fresh
}

function notify() {
	for (const listener of listeners) listener()
}

export function getPinnedIdsSnapshot(workspaceId: string): string[] {
	return read(workspaceId)
}

export function setPinnedIds(workspaceId: string, ids: string[]): void {
	snapshots.set(workspaceId, ids)
	writePinnedPageIdsToStorage(workspaceId, ids)
	notify()
}

export function subscribePinnedIds(listener: Listener): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

// Cross-tab sync. The browser `storage` event only fires in tabs OTHER than
// the one that wrote — local notification is already handled by `notify()`
// above. When another tab writes, drop the cached snapshot so the next read
// reflects the new value, then notify subscribers to re-render.
if (typeof window !== 'undefined') {
	window.addEventListener('storage', (event) => {
		if (!event.key?.startsWith(STORAGE_KEY_PREFIX)) return
		const workspaceId = event.key.slice(STORAGE_KEY_PREFIX.length)
		snapshots.delete(workspaceId)
		notify()
	})
}

// Test helper — resets in-memory state between tests. Not exported from a
// barrel; tests import directly.
export function __resetPinnedPagesStoreForTests(): void {
	snapshots.clear()
	listeners.clear()
}
