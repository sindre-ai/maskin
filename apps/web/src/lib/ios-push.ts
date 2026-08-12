import { isTauri } from './ios-shell'

// Wires APNs registration on iOS: request notification permission, then ask
// UIApplication to registerForRemoteNotifications. The token itself is
// delivered to the AppDelegate on the native side — the JS side only kicks
// registration off and logs the outcome. Inert in a plain browser: the guard
// returns before either plugin loads, so web deploys are unaffected.
export async function initIosPushNotifications(): Promise<void> {
	if (!isTauri()) return

	try {
		const { isPermissionGranted, requestPermission } = await import(
			'@tauri-apps/plugin-notification'
		)
		let granted = await isPermissionGranted()
		if (!granted) {
			const outcome = await requestPermission()
			granted = outcome === 'granted'
		}
		if (!granted) {
			console.warn('[apns] notification permission denied — skipping registration')
			return
		}

		const { invoke } = await import('@tauri-apps/api/core')
		await invoke('register_for_remote_notifications')
		console.info('[apns] registerForRemoteNotifications dispatched — token arrives via AppDelegate')
	} catch (err) {
		console.error('[apns] push-notification init failed', err)
	}
}
