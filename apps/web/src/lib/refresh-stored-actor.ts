import { api } from './api'
import { getStoredActor, setStoredActor } from './auth'

// The browser keeps a copy of the signed-in person that is only written at sign-in. Without this
// a rename in the profile never reaches the greeting until the next sign-in.
export function syncStoredActor(fresh: { id: string; name: string }) {
	const stored = getStoredActor()
	if (!stored || stored.id !== fresh.id || stored.name === fresh.name) return
	setStoredActor({ ...stored, name: fresh.name })
}

let loadRefresh: Promise<void> | null = null

// Reads the live record once per page load. A failed read keeps the saved name and is tried
// again on the next navigation.
export function refreshStoredActor(): Promise<void> {
	const stored = getStoredActor()
	if (!stored) return Promise.resolve()
	if (!loadRefresh) {
		loadRefresh = api.actors.get(stored.id).then(syncStoredActor, () => {
			loadRefresh = null
		})
	}
	return loadRefresh
}
