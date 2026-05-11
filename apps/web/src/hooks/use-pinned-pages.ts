import { useEnabledModules } from '@/hooks/use-enabled-modules'
import {
	ALL_PAGES,
	type PageDefinition,
	getPinnedPageIds,
	setPinnedPageIds,
} from '@/lib/pinned-pages'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@maskin/module-sdk'
import { useCallback, useMemo, useState } from 'react'

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

	// Filtered list of pages that are available given current module state
	const allPages = useMemo(
		() => ALL_PAGES.filter((p) => !p.requiresModuleObjectTypes || hasObjectTypes),
		[hasObjectTypes],
	)

	const availableIds = useMemo(() => new Set(allPages.map((p) => p.id)), [allPages])

	const [pinnedIds, setPinnedIds] = useState<string[]>(() => getPinnedPageIds(workspaceId))

	const [isEditing, setEditing] = useState(false)

	const save = useCallback(
		(ids: string[]) => {
			setPinnedIds(ids)
			setPinnedPageIds(workspaceId, ids)
		},
		[workspaceId],
	)

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
			if (!pinnedIds.includes(pageId)) save([...pinnedIds, pageId])
		},
		[pinnedIds, save],
	)

	const unpin = useCallback(
		(pageId: string) => {
			save(pinnedIds.filter((id) => id !== pageId))
		},
		[pinnedIds, save],
	)

	const reorder = useCallback(
		(fromIndex: number, toIndex: number) => {
			const visible = pinnedPages.map((p) => p.id)
			const next = [...visible]
			const [moved] = next.splice(fromIndex, 1)
			next.splice(toIndex, 0, moved)
			// Preserve any hidden pins (module-gated) at the end of the stored list
			const hiddenIds = pinnedIds.filter((id) => !availableIds.has(id))
			save([...next, ...hiddenIds])
		},
		[pinnedPages, pinnedIds, availableIds, save],
	)

	return { pinnedPages, allPages, isEditing, setEditing, pin, unpin, isPinned, reorder }
}
