import { MutationCache, QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError } from './api'

export const queryClient = new QueryClient({
	mutationCache: new MutationCache({
		onError: (error) => {
			if (error instanceof ApiError && error.hasFieldErrors()) return
			// 402 PLAN_CAP_EXCEEDED is the typed signal from the enforcement layer
			// that the workspace ran out of plan tokens mid-mutation (most often
			// a session create). Refetch billing so the UsageStateBanner flips to
			// the over-cap state immediately; suppress the toast — the banner +
			// composer notice already carry the message.
			if (error instanceof ApiError && error.status === 402) {
				queryClient.invalidateQueries({ queryKey: ['billing'] })
				return
			}
			const message = error instanceof ApiError ? error.message : 'Something went wrong'
			toast.error(message)
		},
	}),
	defaultOptions: {
		queries: {
			staleTime: 30_000,
			retry: (failureCount, error) => {
				if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
					return false
				}
				return failureCount < 3
			},
			retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30_000),
			refetchOnWindowFocus: false,
		},
	},
})
