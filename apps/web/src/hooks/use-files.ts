import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type CreateFileInput, api } from '../lib/api'
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

export function useCreateFile(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateFileInput) => api.files.create(workspaceId, data),
		onSuccess: (file) => {
			queryClient.setQueryData(queryKeys.files.detail(workspaceId, file.id), file)
			queryClient.invalidateQueries({ queryKey: queryKeys.files.all(workspaceId) })
		},
	})
}
