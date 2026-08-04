import { getStoredActor } from '@/lib/auth'

// Founder-only canary gate for the For You redesign. Kept as an inline set —
// this is a single-purpose flag for one bet, not a general feature-flag system.
const FOUNDER_ACTOR_IDS = new Set([
	'3e16ed51-e5e1-4b87-959f-7eda01b21bea', // Sebastian
	'08964c08-4ea5-45b0-bfa9-251f956909c7', // Magnus
])

export function useForyouRedesignFlag(): boolean {
	const actor = getStoredActor()
	if (!actor) return false
	return FOUNDER_ACTOR_IDS.has(actor.id)
}
