import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
	CreateExtensionInput,
	ExtensionToolEffect,
	ExtensionWebhookConfig,
	UpdateExtensionInput,
} from '../lib/api'
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

export function useProbeMcp(workspaceId: string) {
	return useMutation({
		mutationFn: (data: { server_url: string; api_key?: string }) =>
			api.extensions.probeMcp(workspaceId, data),
	})
}

export function useExtensionSample(workspaceId: string, id: string) {
	return useMutation({
		mutationFn: (data: { payload: string; webhook_config?: ExtensionWebhookConfig }) =>
			api.extensions.sample(workspaceId, id, data),
	})
}

/** Refused tool calls land from running sessions, so the page re-reads them while it is open. */
const ATTEMPTED_POLL_MS = 15_000

export function useExtensionAttempted(workspaceId: string, id: string) {
	return useQuery({
		queryKey: queryKeys.extensions.attempted(workspaceId, id),
		queryFn: () => api.extensions.attempted(workspaceId, id),
		enabled: !!workspaceId && !!id,
		refetchInterval: ATTEMPTED_POLL_MS,
	})
}

/** The grants live on the extension row, so every grant change refreshes it (and the list). */
function useRefreshExtension(workspaceId: string, id: string) {
	const queryClient = useQueryClient()
	return () => {
		queryClient.invalidateQueries({ queryKey: queryKeys.extensions.detail(workspaceId, id) })
		queryClient.invalidateQueries({ queryKey: queryKeys.extensions.all(workspaceId) })
	}
}

export function useSetAgentGrant(workspaceId: string, id: string) {
	const refresh = useRefreshExtension(workspaceId, id)
	return useMutation({
		mutationFn: (v: { agentId: string; tools?: Record<string, ExtensionToolEffect> }) =>
			api.extensions.setAgentGrant(workspaceId, id, v.agentId, v.tools),
		onSuccess: refresh,
	})
}

export function useRevokeAgentGrant(workspaceId: string, id: string) {
	const refresh = useRefreshExtension(workspaceId, id)
	return useMutation({
		mutationFn: (agentId: string) => api.extensions.revokeAgentGrant(workspaceId, id, agentId),
		onSuccess: refresh,
	})
}
