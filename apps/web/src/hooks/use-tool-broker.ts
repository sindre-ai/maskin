import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

// Data layer for the tool-broker settings section. Mirrors `use-integrations`
// so the two read the same way; the only difference is the resource.

export function useToolBrokerIntegrations(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.toolBroker.all(workspaceId),
		queryFn: () => api.toolBroker.list(workspaceId),
	})
}

export function useAddToolBrokerIntegration(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (input: { url: string; kind: 'mcp' | 'openapi'; name?: string }) =>
			api.toolBroker.add(workspaceId, input),
		onSuccess: () => {
			// Adding only registers it; it is not usable until connected, so the
			// toast says so rather than implying the tools are live.
			toast.success('Integration added — connect it to make its tools available')
			queryClient.invalidateQueries({ queryKey: queryKeys.toolBroker.all(workspaceId) })
		},
	})
}

export function useConnectToolBrokerIntegration(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			slug,
			auth,
		}: {
			slug: string
			auth: { type: 'none' } | { type: 'api_key'; value: string } | { type: 'oauth' }
		}) => api.toolBroker.connect(workspaceId, slug, auth),
		onSuccess: (result) => {
			// OAuth hands back a URL instead of a finished connection: the user has
			// to approve at the provider, and comes back through our callback.
			if (result.authorizationUrl) {
				window.location.href = result.authorizationUrl
				return
			}
			toast.success('Integration connected')
			queryClient.invalidateQueries({ queryKey: queryKeys.toolBroker.all(workspaceId) })
		},
	})
}

export function useDisconnectToolBrokerIntegration(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (slug: string) => api.toolBroker.disconnect(workspaceId, slug),
		onSuccess: () => {
			toast.success('Integration disconnected')
			queryClient.invalidateQueries({ queryKey: queryKeys.toolBroker.all(workspaceId) })
		},
	})
}
