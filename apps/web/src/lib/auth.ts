const AUTH_KEY = 'ai-native-api-key'
const ACTOR_KEY = 'ai-native-actor'

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
