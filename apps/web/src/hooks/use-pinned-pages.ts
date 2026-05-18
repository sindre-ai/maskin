import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { ALL_PAGES, type PageDefinition } from '@/lib/pinned-pages'
import { useWorkspace } from '@/lib/workspace-context'
import { getPinnedIdsSnapshot, setPinnedIds, subscribePinnedIds } from '@/stores/pinned-pages-store'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'

export interface UsePinnedPagesResult {
	pinnedPages: PageDefinition[]
	allPages: PageDefinition[]
	isEditing: boolean
	setEditing: (v: boolean) => void
	pin: (pageId: string) => void
	unpin: (pageId: string) => void
	isPinned: (pageId: string) => boolean
	reorder: (fromIndex: number, toIndex: number) => void
}

export function usePinnedPages(): UsePinnedPagesResult {
	const { workspaceId } = useWorkspace()
	const enabledModules = useEnabledModules()
	const hasObjectTypes = getEnabledObjectTypeTabs(enabledModules).length > 0

	// Subscribe to the shared store so any consumer (sidebar + /pages) re-renders
	// when pins change anywhere.
	const getSnapshot = useCallback(() => getPinnedIdsSnapshot(workspaceId), [workspaceId])
	const pinnedIds = useSyncExternalStore(subscribePinnedIds, getSnapshot, getSnapshot)

	// `isEditing` stays local — it's the sidebar's UI mode, not shared state.
	const [isEditing, setEditing] = useState(false)

	// Filtered list of pages that are available given current module state
	const allPages = useMemo(
		() => ALL_PAGES.filter((p) => !p.requiresModuleObjectTypes || hasObjectTypes),
		[hasObjectTypes],
	)

	const availableIds = useMemo(() => new Set(allPages.map((p) => p.id)), [allPages])

	// Resolve pinned page definitions, filtering out pages whose module is disabled
	// (pins are preserved in storage so re-enabling the module restores them)
	const pinnedPages = useMemo(
		() =>
			pinnedIds.flatMap((id) => {
				if (!availableIds.has(id)) return []
				const page = allPages.find((p) => p.id === id)
				return page ? [page] : []
			}),
		[pinnedIds, allPages, availableIds],
	)

	const isPinned = useCallback((pageId: string) => pinnedIds.includes(pageId), [pinnedIds])

	const pin = useCallback(
		(pageId: string) => {
			if (!pinnedIds.includes(pageId)) setPinnedIds(workspaceId, [...pinnedIds, pageId])
		},
		[pinnedIds, workspaceId],
	)

	const unpin = useCallback(
		(pageId: string) => {
			setPinnedIds(
				workspaceId,
				pinnedIds.filter((id) => id !== pageId),
			)
		},
		[pinnedIds, workspaceId],
	)

	const reorder = useCallback(
		(fromIndex: number, toIndex: number) => {
			const visible = pinnedPages.map((p) => p.id)
			const next = [...visible]
			const [moved] = next.splice(fromIndex, 1)
			next.splice(toIndex, 0, moved)
			// Preserve any hidden pins (module-gated) at the end of the stored list
			const hiddenIds = pinnedIds.filter((id) => !availableIds.has(id))
			setPinnedIds(workspaceId, [...next, ...hiddenIds])
		},
		[pinnedPages, pinnedIds, availableIds, workspaceId],
	)

	return { pinnedPages, allPages, isEditing, setEditing, pin, unpin, isPinned, reorder }
}
