const AUTH_KEY = 'maskin-api-key'
const ACTOR_KEY = 'maskin-actor'

// Every environment that pulls in the api client runs this module, including
// ones with no usable storage (Safari private mode, storage disabled by policy,
// a non-DOM test environment). In those, *touching* `localStorage` throws a
// `SecurityError` rather than returning null — so every access goes through
// these helpers and degrades to an unauthenticated read instead of taking down
// whichever call site happened to touch storage first.
function readKey(key: string): string | null {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

function writeKey(key: string, value: string) {
	try {
		localStorage.setItem(key, value)
	} catch {
		// Nothing to persist to — the value stays in memory for this session only.
	}
}

function removeKey(key: string) {
	try {
		localStorage.removeItem(key)
	} catch {
		// Nothing to remove from.
	}
}

// Migrate localStorage keys from old ai-native naming.
function migrateKey(oldKey: string, newKey: string) {
	const old = readKey(oldKey)
	if (old && !readKey(newKey)) {
		writeKey(newKey, old)
		removeKey(oldKey)
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
	return readKey(AUTH_KEY)
}

export function setApiKey(key: string) {
	writeKey(AUTH_KEY, key)
}

export function getStoredActor(): StoredActor | null {
	const raw = readKey(ACTOR_KEY)
	if (!raw) return null
	try {
		return JSON.parse(raw)
	} catch {
		// Corrupt value — drop it rather than re-parsing the same poison on every
		// load, and let the caller fall back to an unauthenticated read.
		removeKey(ACTOR_KEY)
		return null
	}
}

export function setStoredActor(actor: StoredActor) {
	writeKey(ACTOR_KEY, JSON.stringify(actor))
}

export function clearAuth() {
	removeKey(AUTH_KEY)
	removeKey(ACTOR_KEY)
}

export function isAuthenticated(): boolean {
	return !!getApiKey()
}
