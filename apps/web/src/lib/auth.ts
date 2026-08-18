const AUTH_KEY = 'maskin-api-key'
const ACTOR_KEY = 'maskin-actor'

// Migrate localStorage keys from old ai-native naming.
//
// This runs at module import, so it executes in every environment that pulls in
// the api client — including ones with no usable storage (Safari private mode,
// storage disabled by policy, a non-DOM test environment). Reading a missing or
// throwing `localStorage` there must not take down the import.
function migrateKey(oldKey: string, newKey: string) {
	try {
		const old = localStorage.getItem(oldKey)
		if (old && !localStorage.getItem(newKey)) {
			localStorage.setItem(newKey, old)
			localStorage.removeItem(oldKey)
		}
	} catch {
		// No storage to migrate — the app falls back to an unauthenticated read.
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

export function getApiKey(): string | null {
	return localStorage.getItem(AUTH_KEY)
}

export function setApiKey(key: string) {
	localStorage.setItem(AUTH_KEY, key)
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
	localStorage.removeItem(AUTH_KEY)
	localStorage.removeItem(ACTOR_KEY)
}

export function isAuthenticated(): boolean {
	return !!getApiKey()
}
