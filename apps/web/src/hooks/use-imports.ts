import type { ImportMappingInput, ImportResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export function useImport(id: string | undefined, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.imports.detail(id ?? ''),
		queryFn: () => api.imports.get(id as string, workspaceId),
		enabled: !!id,
		refetchInterval: (query) => {
			const data = query.state.data as ImportResponse | undefined
			// Poll while importing
			if (data?.status === 'importing') return 2000
			return false
		},
	})
}

export function useCreateImport(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (file: File) => api.imports.create(workspaceId, file),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.imports.all(workspaceId) })
		},
	})
}

export function useUpdateImportMapping(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, mapping }: { id: string; mapping: ImportMappingInput }) =>
			api.imports.updateMapping(id, mapping, workspaceId),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.imports.detail(data.id) })
		},
	})
}

export function useConfirmImport(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.imports.confirm(id, workspaceId),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.imports.detail(data.id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.imports.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
		},
	})
}
