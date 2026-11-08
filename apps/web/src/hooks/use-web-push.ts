import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import {
	getBrowserSubscription,
	getPermission,
	getStoredSubscriptionId,
	isWebPushSupported,
	storeSubscriptionId,
	subscribeBrowser,
	toSubscribeBody,
	unsubscribeBrowser,
} from '@/lib/web-push'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useReducer } from 'react'

const SUBSCRIPTION_KEY = ['web-push', 'browser-subscription'] as const

export type WebPushState =
	| 'unavailable' // server has no VAPID keys, or this browser has no Push API
	| 'blocked' // the user denied permission in browser settings
	| 'off'
	| 'on'

/**
 * Browser notifications for the current browser. `state` is what the Profile toggle renders;
 * `enable` must be called from a click (it may show the permission prompt).
 */
export function useWebPush() {
	const queryClient = useQueryClient()
	const supported = isWebPushSupported()

	// The permission is read from the browser at render time, so a change made in site settings is
	// only seen after a re-render. Re-read it when the tab regains focus, so "blocked" clears
	// without a reload.
	const [, rereadPermission] = useReducer((n: number) => n + 1, 0)
	useEffect(() => {
		if (!supported) return
		const onVisible = () => {
			if (document.visibilityState === 'visible') rereadPermission()
		}
		window.addEventListener('focus', rereadPermission)
		document.addEventListener('visibilitychange', onVisible)
		return () => {
			window.removeEventListener('focus', rereadPermission)
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [supported])

	const config = useQuery({
		queryKey: queryKeys.webPush.config(),
		queryFn: () => api.webPush.config(),
		enabled: supported,
		staleTime: 5 * 60_000,
	})

	const browserSubscription = useQuery({
		queryKey: SUBSCRIPTION_KEY,
		queryFn: async () => (await getBrowserSubscription()) !== null,
		enabled: supported,
		// The browser, not the server, is the source of truth for "is this browser subscribed".
		staleTime: 0,
	})

	const enable = useMutation({
		mutationFn: async () => {
			const publicKey = config.data?.public_key
			if (!publicKey) throw new Error('Browser notifications are not configured')
			const outcome = await subscribeBrowser(publicKey)
			if (outcome.status === 'denied') return 'denied' as const
			if (outcome.status === 'dismissed') return 'dismissed' as const
			const saved = await api.webPush.subscribe(toSubscribeBody(outcome.subscription))
			storeSubscriptionId(saved.id)
			return 'subscribed' as const
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey: SUBSCRIPTION_KEY }),
	})

	const disable = useMutation({
		mutationFn: async () => {
			const id = getStoredSubscriptionId()
			if (id) {
				// A 404 means the row is already gone; the browser unsubscribe below still runs.
				await api.webPush.unsubscribe(id).catch(() => undefined)
			}
			await unsubscribeBrowser()
			storeSubscriptionId(null)
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey: SUBSCRIPTION_KEY }),
	})

	let state: WebPushState = 'unavailable'
	if (supported && config.data?.enabled) {
		if (browserSubscription.data && getPermission() === 'granted') state = 'on'
		else state = getPermission() === 'denied' ? 'blocked' : 'off'
	}

	return {
		state,
		isLoading: supported && (config.isLoading || browserSubscription.isLoading),
		enable,
		disable,
	}
}
