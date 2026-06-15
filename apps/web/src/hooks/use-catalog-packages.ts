import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export interface CatalogPackagesFilters {
	type?: string
	use_case?: string
	q?: string
}

export function useCatalogPackages(filters?: CatalogPackagesFilters) {
	return useQuery({
		queryKey: queryKeys.catalogPackages.list(filters),
		queryFn: () => api.catalogPackages.list(filters),
	})
}

export function useCatalogPackage(id: string | undefined) {
	return useQuery({
		queryKey: queryKeys.catalogPackages.detail(id ?? ''),
		queryFn: () => api.catalogPackages.get(id as string),
		enabled: Boolean(id),
	})
}

export function useInstallCatalogItem(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (itemId: string) => api.catalogItems.install(itemId, workspaceId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.catalogItems.installed(workspaceId) })
		},
	})
}

export function useInstalledCatalogItems(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.catalogItems.installed(workspaceId),
		queryFn: () => api.catalogItems.installed(workspaceId),
	})
}

export function useUninstallCatalogItem(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			itemId,
			keepProvisionedItems,
		}: { itemId: string; keepProvisionedItems: boolean }) =>
			api.catalogItems.uninstall(itemId, workspaceId, keepProvisionedItems),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.catalogItems.installed(workspaceId) })
		},
	})
}
