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
		mutationFn: (provider: string) => api.integrations.connect(workspaceId, provider),
		onSuccess: (data) => {
			// Redirect to the provider's install/OAuth page
			window.location.href = data.install_url
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
