import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

// Data layer for the tool-broker settings section. Mirrors `use-integrations`
// so the two read the same way; the only difference is the resource.

export function useToolBrokerIntegrations(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.toolBroker.all(workspaceId),
		queryFn: () => api.toolBroker.list(workspaceId),
	})
}

export function useToolBrokerCatalog(workspaceId: string, q: string) {
	return useQuery({
		queryKey: queryKeys.toolBroker.catalog(workspaceId, q),
		queryFn: () => api.toolBroker.catalog(workspaceId, q),
		// The list is a browse surface, not live data — refetching on every focus
		// makes it flicker while someone is reading it.
		staleTime: 60_000,
	})
}

const CATALOG_PAGE_SIZE = 50

/**
 * The catalogue, one page at a time.
 *
 * `total` is the count of everything matching, so the next-page decision comes
 * from how many rows we already hold rather than from a short final page —
 * which also means a page that happens to be exactly full does not cause one
 * pointless extra request at the end.
 */
export function useToolBrokerCatalogInfinite(workspaceId: string, q: string, enabled = true) {
	return useInfiniteQuery({
		// Off until the browser is actually opened. The catalogue is hundreds of
		// rows and nobody has asked to see it just by loading the settings page.
		enabled,
		queryKey: queryKeys.toolBroker.catalogInfinite(workspaceId, q),
		queryFn: ({ pageParam }) =>
			api.toolBroker.catalog(workspaceId, q, { limit: CATALOG_PAGE_SIZE, offset: pageParam }),
		getNextPageParam: (lastPage, allPages) => {
			const loaded = allPages.reduce((sum, page) => sum + page.entries.length, 0)
			return loaded >= lastPage.total ? undefined : loaded
		},
		initialPageParam: 0,
		staleTime: 60_000,
	})
}

export function useAddToolBrokerIntegration(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (input: {
			url: string
			kind: 'mcp' | 'openapi'
			name?: string
			apiKeyHeader?: { name: string; value: string }
		}) => api.toolBroker.add(workspaceId, input),
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
