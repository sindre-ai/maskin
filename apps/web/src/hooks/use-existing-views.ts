import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

/**
 * The views whose file still exists, in the same order. A view is only a reference to a file, so a
 * deleted file just stops showing instead of leaving a tab that cannot open. Until the check
 * answers, every view is kept: a slow check never hides a tab that is fine.
 */
export function useExistingViews<T extends { fileId: string }>(
	workspaceId: string,
	views: T[],
): T[] {
	const ids = useMemo(() => [...new Set(views.map((v) => v.fileId))].sort(), [views])
	const { data } = useQuery({
		queryKey: [...queryKeys.files.all(workspaceId), 'page-views', ids.join(',')],
		queryFn: () => api.files.list(workspaceId, { ids, limit: Math.max(ids.length, 1) }),
		enabled: !!workspaceId && ids.length > 0,
	})
	return useMemo(() => {
		if (ids.length === 0 || !data) return views
		const found = new Set(data.map((file) => file.id))
		return views.filter((v) => found.has(v.fileId))
	}, [views, ids, data])
}
