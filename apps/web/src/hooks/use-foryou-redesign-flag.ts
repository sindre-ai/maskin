import { getStoredActor } from '@/lib/auth'

// Founder-only canary gate for the For You redesign. Kept as an inline set —
// this is a single-purpose flag for one bet, not a general feature-flag system.
const FOUNDER_ACTOR_IDS = new Set([
	'3e16ed51-e5e1-4b87-959f-7eda01b21bea', // Sebastian
	'08964c08-4ea5-45b0-bfa9-251f956909c7', // Magnus
])

// DEV-only bypass so the T5 Playwright spec can drive the redesign path
// without being a founder actor. Stripped from the production bundle by Vite
// so the canary stays founder-only on the deployed slot.
const DEV_OVERRIDE_KEY = 'maskin-flag-foryou-redesign'

export function useForyouRedesignFlag(): boolean {
	if (import.meta.env.DEV && localStorage.getItem(DEV_OVERRIDE_KEY) === '1') {
		return true
	}
	const actor = getStoredActor()
	if (!actor) return false
	return FOUNDER_ACTOR_IDS.has(actor.id)
}
