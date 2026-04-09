import type { createObjectSchema, updateObjectSchema } from '@maskin/shared'
import type { InfiniteData } from '@tanstack/react-query'
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

export function useToggleStar(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, isStarred }: { id: string; isStarred: boolean }) =>
			api.objects.update(id, { isStarred }),
		onMutate: async ({ id, isStarred }) => {
			// Cancel outgoing refetches so they don't overwrite our optimistic update
			await queryClient.cancelQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			await queryClient.cancelQueries({ queryKey: queryKeys.objects.detail(id) })

			// Snapshot previous values for rollback
			const previousDetail = queryClient.getQueryData<ObjectResponse>(queryKeys.objects.detail(id))

			// Optimistically update detail cache
			if (previousDetail) {
				queryClient.setQueryData<ObjectResponse>(queryKeys.objects.detail(id), {
					...previousDetail,
					isStarred,
				})
			}

			// Optimistically update all infinite query caches that contain this object
			const infiniteQueries = queryClient.getQueriesData<InfiniteData<ObjectResponse[]>>({
				queryKey: queryKeys.objects.all(workspaceId),
			})
			const previousInfinite = new Map(infiniteQueries)
			for (const [key, data] of infiniteQueries) {
				if (!data?.pages) continue
				queryClient.setQueryData<InfiniteData<ObjectResponse[]>>(key, {
					...data,
					pages: data.pages.map((page) =>
						page.map((obj) => (obj.id === id ? { ...obj, isStarred } : obj)),
					),
				})
			}

			return { previousDetail, previousInfinite }
		},
		onError: (_err, { id }, context) => {
			// Rollback on error
			if (context?.previousDetail) {
				queryClient.setQueryData(queryKeys.objects.detail(id), context.previousDetail)
			}
			if (context?.previousInfinite) {
				for (const [key, data] of context.previousInfinite) {
					queryClient.setQueryData(key, data)
				}
			}
		},
		onSettled: (_data, _err, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
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
