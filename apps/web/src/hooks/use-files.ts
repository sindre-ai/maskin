import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useFile(workspaceId: string, fileId: string | null) {
	return useQuery({
		queryKey: queryKeys.files.detail(workspaceId, fileId ?? ''),
		// biome-ignore lint/style/noNonNullAssertion: guarded by enabled
		queryFn: () => api.files.get(workspaceId, fileId!),
		enabled: !!workspaceId && !!fileId,
	})
}

export function useFiles(workspaceId: string, params?: { q?: string }) {
	return useQuery({
		queryKey: [...queryKeys.files.all(workspaceId), 'list', params],
		queryFn: () => api.files.list(workspaceId, params),
		enabled: !!workspaceId,
	})
}
