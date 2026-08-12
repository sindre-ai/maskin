const AUTH_KEY = 'maskin-api-key'
const ACTOR_KEY = 'maskin-actor'

// Migrate localStorage keys from old ai-native naming
function migrateKey(oldKey: string, newKey: string) {
	const old = localStorage.getItem(oldKey)
	if (old && !localStorage.getItem(newKey)) {
		localStorage.setItem(newKey, old)
		localStorage.removeItem(oldKey)
	}
}
migrateKey('ai-native-api-key', AUTH_KEY)
migrateKey('ai-native-actor', ACTOR_KEY)

export interface StoredActor {
	id: string
	name: string
	type: string
	email: string | null
}

// ---- iOS Keychain backend (Tauri shell) ----
// Inside apps/native the plaintext key must live in the iOS Keychain, never web
// storage. getApiKey() stays synchronous everywhere, so on relaunch we hydrate
// this cache from the Keychain (restoreSession) before the router mounts; the
// plain web app keeps behaving exactly as before, on localStorage.
let cachedApiKey: string | null = null

function isTauriShell(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

type TauriInternals = {
	__TAURI_INTERNALS__?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> }
}

// The shell (apps/native) exposes the keychain commands via the injected
// __TAURI_INTERNALS__.invoke bridge so no @tauri-apps dependency is added to
// the web bundle. The bridge only exists in the shell; outside it these calls
// throw and fall through, leaving the web path untouched.
async function keychainInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
	const internals = (window as TauriInternals).__TAURI_INTERNALS__
	return internals?.invoke(cmd, args)
}

async function keychainSetKey(key: string): Promise<void> {
	if (!isTauriShell()) return
	try {
		await keychainInvoke('set_api_key', { key })
	} catch {
		/* web fallback — nothing stored in the keychain */
	}
}

async function keychainDeleteKey(): Promise<void> {
	if (!isTauriShell()) return
	try {
		await keychainInvoke('delete_api_key')
	} catch {
		/* sign-out is idempotent on the shell side too */
	}
}

/**
 * Restores the session after relaunch by reading the API key from the iOS
 * Keychain. Called from main.tsx before the router mounts so the `_authed`
 * guard sees the key; a fresh install (nothing stored) simply stays logged out.
 */
export async function restoreSession(): Promise<void> {
	if (!isTauriShell()) return
	try {
		const key = (await keychainInvoke('get_api_key')) as string | null
		if (key) cachedApiKey = key
	} catch {
		/* no stored credential — falls through to the login screen */
	}
}

export function getApiKey(): string | null {
	if (isTauriShell()) return cachedApiKey
	return localStorage.getItem(AUTH_KEY)
}

export function setApiKey(key: string) {
	if (isTauriShell()) {
		cachedApiKey = key
		void keychainSetKey(key)
	} else {
		localStorage.setItem(AUTH_KEY, key)
	}
}

export function getStoredActor(): StoredActor | null {
	const raw = localStorage.getItem(ACTOR_KEY)
	if (!raw) return null
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

export function setStoredActor(actor: StoredActor) {
	localStorage.setItem(ACTOR_KEY, JSON.stringify(actor))
}

export function clearAuth() {
	cachedApiKey = null
	localStorage.removeItem(AUTH_KEY)
	localStorage.removeItem(ACTOR_KEY)
	if (isTauriShell()) void keychainDeleteKey()
}

export function isAuthenticated(): boolean {
	return !!getApiKey()
}
