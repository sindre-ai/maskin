import {
	getServerReachability,
	onServerRecovered,
	subscribeServerReachability,
} from '@/lib/server-reachability'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'

export function useServerReachability() {
	return useSyncExternalStore(
		subscribeServerReachability,
		getServerReachability,
		getServerReachability,
	)
}

/**
 * When the server comes back, retry whatever gave up while it was away: queries
 * stuck in an error state and any route showing its "Something went wrong"
 * screen. Mount once, at the root.
 */
export function useRecoverWhenServerReturns() {
	const queryClient = useQueryClient()
	const router = useRouter()

	useEffect(
		() =>
			onServerRecovered(() => {
				void queryClient.refetchQueries({ predicate: (query) => query.state.status === 'error' })
				void router.invalidate()
			}),
		[queryClient, router],
	)
}
