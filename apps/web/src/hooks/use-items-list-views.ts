import { useCanWrite } from '@/hooks/use-can-write'
import { usePageViewActions } from '@/hooks/use-page-view-actions'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { listViewsSettingsPatch, readListViews } from '@/lib/page-views'
import { useWorkspace } from '@/lib/workspace-context'
import { useCallback, useMemo } from 'react'

/**
 * The custom views on the Items list for one object type (undefined is the list with no type
 * picked), for the tab row. They are read from workspace settings, so every member sees them.
 * Empty when `enabled` is false.
 */
export function useItemsListViews(type: string | undefined, enabled: boolean) {
	const { workspaceId, workspace } = useWorkspace()
	const canWrite = useCanWrite()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const settings = workspace.settings
	const views = useMemo(
		() => (enabled ? readListViews(settings, type) : []),
		[enabled, settings, type],
	)

	// Settings are read again before every read and write: the server replaces the whole list map,
	// and an agent may have attached a view since the page loaded.
	const freshSettings = useCallback(async () => {
		const all = await api.workspaces.list()
		return all.find((w) => w.id === workspaceId)?.settings ?? settings
	}, [workspaceId, settings])
	const readStored = useCallback(
		async () => readListViews(await freshSettings(), type),
		[freshSettings, type],
	)
	const write = useCallback(
		async (next: typeof views) => {
			await updateWorkspace.mutateAsync({
				settings: listViewsSettingsPatch(await freshSettings(), type, next),
			})
		},
		[updateWorkspace, freshSettings, type],
	)
	const actions = usePageViewActions({ readStored, write })

	return { views, canWrite, ...actions }
}
