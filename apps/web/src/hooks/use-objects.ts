import type { createObjectSchema, updateObjectSchema } from '@maskin/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { z } from 'zod'
import type { ObjectResponse } from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

type CreateObjectInput = z.input<typeof createObjectSchema>
type UpdateObjectInput = z.input<typeof updateObjectSchema>

export function useObjects(workspaceId: string, filters?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.objects.list(workspaceId, filters),
		queryFn: () => api.objects.list(workspaceId, filters),
	})
}

export function useObject(id: string) {
	return useQuery({
		queryKey: queryKeys.objects.detail(id),
		queryFn: () => api.objects.get(id),
		enabled: !!id,
	})
}

export function useObjectGraph(workspaceId: string, id: string) {
	return useQuery({
		queryKey: queryKeys.objects.graph(id),
		queryFn: () => api.objects.graph(id, workspaceId),
		enabled: !!id && !!workspaceId,
	})
}

export function useCreateObject(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateObjectInput) => api.objects.create(workspaceId, data),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.objects.detail(data.id), data)
		},
		onSettled: (_data, _err, variables) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			if (variables.type === 'bet') {
				queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
			}
		},
	})
}

export function useUpdateObject(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateObjectInput }) =>
			api.objects.update(id, data),
		onSettled: (_data, _err, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		},
	})
}

export function useDeleteObject(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.objects.delete(id),
		onSuccess: () => {
			toast.success('Object deleted')
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		},
	})
}
