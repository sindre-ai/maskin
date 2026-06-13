import { useQuery } from '@tanstack/react-query'
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
