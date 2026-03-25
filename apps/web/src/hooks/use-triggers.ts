import type { createTriggerSchema, updateTriggerSchema } from '@ai-native/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { z } from 'zod'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

type CreateTriggerInput = z.input<typeof createTriggerSchema>
type UpdateTriggerInput = z.input<typeof updateTriggerSchema>

export function useTriggers(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.triggers.all(workspaceId),
		queryFn: () => api.triggers.list(workspaceId),
	})
}

export function useTrigger(id: string, workspaceId: string) {
	const { data: triggers, ...rest } = useTriggers(workspaceId)
	return {
		...rest,
		data: triggers?.find((t) => t.id === id),
	}
}

export function useCreateTrigger(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateTriggerInput) => api.triggers.create(workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
		},
	})
}

export function useUpdateTrigger(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateTriggerInput }) =>
			api.triggers.update(id, workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
		},
	})
}

export function useDeleteTrigger(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.triggers.delete(id, workspaceId),
		onSuccess: () => {
			toast.success('Trigger deleted')
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
		},
	})
}
