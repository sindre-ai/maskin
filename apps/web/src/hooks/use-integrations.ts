import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useIntegrations(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.integrations.all(workspaceId),
		queryFn: () => api.integrations.list(workspaceId),
	})
}

export function useProviders() {
	return useQuery({
		queryKey: queryKeys.integrations.providers(),
		queryFn: () => api.integrations.providers(),
	})
}

export function useConnectIntegration(workspaceId: string) {
	return useMutation({
		mutationFn: (input: { provider: string; apiKey?: string }) =>
			api.integrations.connect(
				workspaceId,
				input.provider,
				input.apiKey ? { api_key: input.apiKey } : undefined,
			),
		onSuccess: (data) => {
			// Redirect to the provider's install/OAuth page
			window.location.href = data.redirect_url ?? data.install_url
		},
	})
}

export function useDisconnectIntegration(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.integrations.disconnect(id, workspaceId),
		onSuccess: () => {
			toast.success('Integration disconnected')
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		},
	})
}

const FIVE_MINUTES = 5 * 60 * 1000

export function useSlackConversations(
	integrationId: string | undefined,
	workspaceId: string,
	types?: string[],
) {
	const resolvedTypes = types ?? ['public_channel', 'private_channel', 'im', 'mpim']
	return useQuery({
		queryKey: queryKeys.integrations.slackConversations(integrationId ?? '', resolvedTypes),
		queryFn: () =>
			api.integrations.slackConversations(integrationId as string, workspaceId, resolvedTypes),
		enabled: Boolean(integrationId),
		staleTime: FIVE_MINUTES,
	})
}

export function useSlackUsers(integrationId: string | undefined, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.integrations.slackUsers(integrationId ?? ''),
		queryFn: () => api.integrations.slackUsers(integrationId as string, workspaceId),
		enabled: Boolean(integrationId),
		staleTime: FIVE_MINUTES,
	})
}
