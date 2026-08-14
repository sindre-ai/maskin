import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export interface MarketplaceLoopsFilters {
	type?: string
	use_case?: string
	q?: string
}

export function useMarketplaceLoops(filters?: MarketplaceLoopsFilters) {
	return useQuery({
		queryKey: queryKeys.marketplaceLoops.list(filters),
		queryFn: () => api.marketplaceLoops.list(filters),
	})
}

export function useMarketplaceLoop(id: string) {
	return useQuery({
		queryKey: queryKeys.marketplaceLoops.detail(id),
		queryFn: () => api.marketplaceLoops.get(id),
		enabled: Boolean(id),
	})
}

export function useInstallMarketplaceItem(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (itemId: string) => api.marketplaceItems.install(itemId, workspaceId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.marketplaceItems.installed(workspaceId) })
		},
	})
}

export function useInstalledMarketplaceItems(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.marketplaceItems.installed(workspaceId),
		queryFn: () => api.marketplaceItems.installed(workspaceId),
	})
}

export function useUninstallMarketplaceItem(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			itemId,
			keepProvisionedItems,
		}: { itemId: string; keepProvisionedItems: boolean }) =>
			api.marketplaceItems.uninstall(itemId, workspaceId, keepProvisionedItems),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.marketplaceItems.installed(workspaceId) })
		},
	})
}
