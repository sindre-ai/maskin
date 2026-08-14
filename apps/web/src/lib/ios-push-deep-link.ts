import { navigateToForYouCard } from './foryou-focus'
import { isTauri } from './ios-shell'

const PUSH_NOTIFICATION_TAPPED_EVENT = 'push-notification-tapped'

interface PendingNotification {
	entity_type: string
	entity_id: string
}

// Runtime guard for the shape the Rust bridge hands back. Both fields are
// required at the FFI layer, but the type coming out of `invoke` is
// `unknown` — this narrows it defensively so a malformed payload can't hop
// through to the router.
function isPendingNotification(v: unknown): v is PendingNotification {
	if (!v || typeof v !== 'object') return false
	const { entity_type, entity_id } = v as Record<string, unknown>
	return (
		typeof entity_type === 'string' &&
		entity_type.length > 0 &&
		typeof entity_id === 'string' &&
		entity_id.length > 0
	)
}

async function consumeAndRoute(): Promise<void> {
	try {
		const { invoke } = await import('@tauri-apps/api/core')
		const payload = (await invoke('consume_pending_notification')) as unknown
		if (!isPendingNotification(payload)) return
		navigateToForYouCard(payload.entity_type, payload.entity_id)
	} catch (err) {
		console.error('[apns] consume_pending_notification failed', err)
	}
}

/**
 * Wires the iOS push-notification tap → For You card deep-link.
 *
 * On tap, the AppDelegate hands the payload to the Rust bridge — this
 * function reads it back in three complementary places:
 *   1. Once at boot, awaited before the router mounts, so the cold-start
 *      case (app launched *by* the notification) lands the `?card=...` param
 *      in the URL before the route's first render.
 *   2. On `visibilitychange` when the tab becomes visible, so a warm-state
 *      tap that woke the app from background is picked up as soon as the
 *      webview repaints.
 *   3. Via the `push-notification-tapped` Tauri event the Rust bridge emits
 *      alongside its stash — a belt-and-braces path so a warm tap routes
 *      without waiting for the visibility repaint.
 *
 * Inert in a plain browser: the isTauri() guard returns before either
 * `@tauri-apps/api` module loads, so web deploys pay nothing.
 */
export async function initIosPushDeepLink(): Promise<void> {
	if (!isTauri()) return

	// (1) Cold-start read — must complete before the router mounts.
	await consumeAndRoute()

	// (2) Warm-state visibility flip.
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void consumeAndRoute()
	})

	// (3) Warm-state event push from Rust — bypasses the visibility wait.
	try {
		const { listen } = await import('@tauri-apps/api/event')
		await listen<PendingNotification>(PUSH_NOTIFICATION_TAPPED_EVENT, (event) => {
			if (!isPendingNotification(event.payload)) return
			navigateToForYouCard(event.payload.entity_type, event.payload.entity_id)
		})
	} catch (err) {
		// The event plugin can fail to load in edge harness cases (e.g. a
		// preview build with the plugin disabled); the visibility path
		// still covers warm-state so we don't want a hard failure here.
		console.error('[apns] push-notification-tapped listener failed to register', err)
	}
}
