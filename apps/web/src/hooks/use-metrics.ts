import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useMetrics() {
	return useQuery({
		queryKey: queryKeys.metrics.all(),
		queryFn: () => api.metrics.get(),
		refetchInterval: 30_000,
	})
}

export function usePublicMetrics() {
	return useQuery({
		queryKey: queryKeys.metrics.public(),
		queryFn: () => api.metrics.public(),
		refetchInterval: 60_000,
	})
}
