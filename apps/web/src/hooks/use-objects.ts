import type { createObjectSchema, updateObjectSchema } from '@ai-native/shared'
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

export function useCreateObject(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateObjectInput) => api.objects.create(workspaceId, data),
		onMutate: async (data) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.objects.all(workspaceId) })

			const optimistic: ObjectResponse = {
				id: `optimistic-${crypto.randomUUID()}`,
				workspaceId,
				type: data.type,
				title: data.title ?? null,
				content: data.content ?? null,
				status: data.status,
				metadata: (data.metadata as Record<string, unknown>) ?? null,
				owner: data.owner ?? null,
				activeSessionId: null,
				createdBy: '',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}

			const previousQueries: [readonly unknown[], ObjectResponse[] | undefined][] = []
			const queries = queryClient.getQueriesData<ObjectResponse[]>({
				queryKey: queryKeys.objects.all(workspaceId),
			})
			for (const [key, data] of queries) {
				if (data) {
					previousQueries.push([key, data])
					queryClient.setQueryData(key, [optimistic, ...data])
				}
			}

			return { previousQueries }
		},
		onError: (_err, _data, context) => {
			for (const [key, data] of context?.previousQueries ?? []) {
				queryClient.setQueryData(key, data)
			}
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
		onMutate: async ({ id, data }) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.objects.detail(id) })
			const previous = queryClient.getQueryData<ObjectResponse>(queryKeys.objects.detail(id))
			if (previous) {
				queryClient.setQueryData(queryKeys.objects.detail(id), { ...previous, ...data })
			}
			return { previous }
		},
		onError: (_err, { id }, context) => {
			if (context?.previous) {
				queryClient.setQueryData(queryKeys.objects.detail(id), context.previous)
			}
		},
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
		onMutate: async (id) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.objects.all(workspaceId) })

			const previousQueries: [readonly unknown[], ObjectResponse[] | undefined][] = []
			const queries = queryClient.getQueriesData<ObjectResponse[]>({
				queryKey: queryKeys.objects.all(workspaceId),
			})
			for (const [key, data] of queries) {
				if (data) {
					previousQueries.push([key, data])
					queryClient.setQueryData(
						key,
						data.filter((obj) => obj.id !== id),
					)
				}
			}

			return { previousQueries }
		},
		onError: (_err, _id, context) => {
			for (const [key, data] of context?.previousQueries ?? []) {
				queryClient.setQueryData(key, data)
			}
		},
		onSuccess: () => {
			toast.success('Object deleted')
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		},
	})
}
