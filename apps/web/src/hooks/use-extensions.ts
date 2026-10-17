import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateExtensionInput, ExtensionWebhookConfig, UpdateExtensionInput } from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useExtensions(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.extensions.all(workspaceId),
		queryFn: () => api.extensions.list(workspaceId),
		enabled: !!workspaceId,
	})
}

/** While nothing has been delivered yet the page polls, so the "Receiving" step flips on its own. */
const WAITING_POLL_MS = 5000

export function useExtension(workspaceId: string, id: string) {
	return useQuery({
		queryKey: queryKeys.extensions.detail(workspaceId, id),
		queryFn: () => api.extensions.get(workspaceId, id),
		enabled: !!workspaceId && !!id,
		refetchInterval: (query) => {
			const ext = query.state.data
			return ext?.webhookConfig && ext.committedDeliveries === 0 ? WAITING_POLL_MS : false
		},
	})
}

export function useExtensionDeliveries(workspaceId: string, id: string, waiting: boolean) {
	return useQuery({
		queryKey: queryKeys.extensions.deliveries(workspaceId, id),
		queryFn: () => api.extensions.deliveries(workspaceId, id),
		enabled: !!workspaceId && !!id,
		refetchInterval: waiting ? WAITING_POLL_MS : false,
	})
}

export function useVendorRecipes(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.extensions.recipes(workspaceId),
		queryFn: () => api.extensions.recipes(workspaceId),
		enabled: !!workspaceId,
		staleTime: 60 * 60 * 1000,
	})
}

export function useCreateExtension(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateExtensionInput) => api.extensions.create(workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.extensions.all(workspaceId) })
		},
	})
}

export function useUpdateExtension(workspaceId: string, id: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: UpdateExtensionInput) => api.extensions.update(workspaceId, id, data),
		onSuccess: (ext) => {
			queryClient.setQueryData(queryKeys.extensions.detail(workspaceId, id), ext)
			queryClient.invalidateQueries({ queryKey: queryKeys.extensions.all(workspaceId) })
		},
	})
}

export function useRegenerateExtensionToken(workspaceId: string, id: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: () => api.extensions.regenerateToken(workspaceId, id),
		onSuccess: (ext) => {
			queryClient.setQueryData(queryKeys.extensions.detail(workspaceId, id), ext)
			queryClient.invalidateQueries({ queryKey: queryKeys.extensions.all(workspaceId) })
		},
	})
}

export function useGenerateExtensionSecret(workspaceId: string) {
	return useMutation({ mutationFn: () => api.extensions.generateSecret(workspaceId) })
}

export function useExtensionSample(workspaceId: string, id: string) {
	return useMutation({
		mutationFn: (data: { payload: string; webhook_config?: ExtensionWebhookConfig }) =>
			api.extensions.sample(workspaceId, id, data),
	})
}
