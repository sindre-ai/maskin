import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type CreateFileInput, type FileDetail, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useFile(workspaceId: string, fileId: string | null) {
	return useQuery({
		queryKey: queryKeys.files.detail(workspaceId, fileId ?? ''),
		// biome-ignore lint/style/noNonNullAssertion: guarded by enabled
		queryFn: () => api.files.get(workspaceId, fileId!),
		enabled: !!workspaceId && !!fileId,
	})
}

export function useFiles(workspaceId: string, params?: { q?: string; ids?: string[] }) {
	return useQuery({
		queryKey: [...queryKeys.files.all(workspaceId), 'list', params],
		queryFn: () => api.files.list(workspaceId, params),
		enabled: !!workspaceId && !(params?.ids !== undefined && params.ids.length === 0),
	})
}

function primeFileCaches(queryClient: ReturnType<typeof useQueryClient>, file: FileDetail) {
	queryClient.setQueryData(queryKeys.files.detail(file.workspaceId, file.id), file)
	queryClient.invalidateQueries({ queryKey: queryKeys.files.all(file.workspaceId) })
}

export function useCreateFile(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateFileInput) => api.files.create(workspaceId, data),
		onSuccess: (file) => primeFileCaches(queryClient, file),
	})
}

/**
 * Imperative upload helper for callers that need byte-level progress and
 * cancellation — e.g. the comment composer's attachment chips. Use the
 * `useCreateFile` mutation when you don't need progress.
 */
export function useUploadFile(workspaceId: string) {
	const queryClient = useQueryClient()
	return (
		data: CreateFileInput,
		opts?: { onProgress?: (progress: number) => void; signal?: AbortSignal },
	) =>
		api.files.createWithProgress(workspaceId, data, opts).then((file) => {
			primeFileCaches(queryClient, file)
			return file
		})
}
