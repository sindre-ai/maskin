import type { ApnsEnvironment } from '@maskin/shared'
import { api } from './api'
import { getApiKey } from './auth'
import { isTauri } from './ios-shell'

const APNS_DEVICE_TOKEN_EVENT = 'apns-device-token'

interface ApnsDeviceTokenPayload {
	token: string
	environment: ApnsEnvironment
}

// Runtime guard for the shape the Rust bridge hands back. The FFI layer
// already validates non-empty + UTF-8, but the JS boundary sees `unknown`
// out of `invoke`/`event.payload` — this narrows defensively so a malformed
// payload can't hop through to the PATCH.
function isApnsDeviceTokenPayload(v: unknown): v is ApnsDeviceTokenPayload {
	if (!v || typeof v !== 'object') return false
	const { token, environment } = v as Record<string, unknown>
	if (typeof token !== 'string' || token.length === 0) return false
	return environment === 'sandbox' || environment === 'production'
}

async function registerWithBackend(payload: ApnsDeviceTokenPayload): Promise<void> {
	// A cold boot can hand the token to Rust before the shell has restored
	// the API key from the Keychain (and before login on first launch). Skip
	// silently — the next foreground re-triggers OS registration, and the
	// backend PATCH will run then instead of surfacing a spurious 401.
	if (!getApiKey()) return
	try {
		await api.apnsTokens.register(payload)
	} catch (err) {
		console.error('[apns] token registration failed', err)
	}
}

/**
 * Wires the iOS APNs device-token → backend PATCH.
 *
 * The shell kicks OS registration on every launch (`initIosPushNotifications`).
 * When iOS returns the token, the AppDelegate hands it to the Rust bridge,
 * which stashes it in a mutex slot and emits `apns-device-token`. This
 * function reads both:
 *   1. The event listener catches a warm-path token (already-running app,
 *      or webview mounted before the OS callback fires).
 *   2. The `consume_pending_apns_token` invoke catches the cold-start race
 *      where the OS delivers the token before the listener is attached.
 *
 * Idempotent by design — the backend upserts by token, so re-registering the
 * same token on every launch is a no-op beyond bumping `updated_at`.
 *
 * Inert in a plain browser: the `isTauri()` guard returns before either
 * `@tauri-apps/api` module loads, so web deploys pay nothing.
 */
export async function initIosPushTokenRegistration(): Promise<void> {
	if (!isTauri()) return

	// (1) Listen for warm-path tokens first, so a listener is attached
	// before `initIosPushNotifications()` kicks OS-side registration in
	// main.tsx. Otherwise a fast APNs handshake could emit the event
	// before this promise resolves and we'd drop the first token silently.
	try {
		const { listen } = await import('@tauri-apps/api/event')
		await listen<ApnsDeviceTokenPayload>(APNS_DEVICE_TOKEN_EVENT, (event) => {
			if (!isApnsDeviceTokenPayload(event.payload)) return
			void registerWithBackend(event.payload)
		})
	} catch (err) {
		// The event plugin can fail to load in edge harness cases (a preview
		// build with the plugin disabled). The consume path below still
		// covers the cold-start case so this isn't a hard failure.
		console.error('[apns] token event listener failed to register', err)
	}

	// (2) Cold-start read — catches a token stashed by the AppDelegate
	// before this module even loaded (webview mount races the OS callback).
	try {
		const { invoke } = await import('@tauri-apps/api/core')
		const payload = (await invoke('consume_pending_apns_token')) as unknown
		if (!isApnsDeviceTokenPayload(payload)) return
		await registerWithBackend(payload)
	} catch (err) {
		console.error('[apns] consume_pending_apns_token failed', err)
	}
}
