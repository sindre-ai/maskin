import { setApiKey, setStoredActor } from './auth'

/**
 * Consumes credentials from the URL fragment and stores them in localStorage,
 * then strips the fragment. Used so MCP `get_started` can return a one-click
 * link that auto-authenticates the user and populates their profile.
 *
 * Supported fragment params: `key` (required, must start with `ank_`),
 * `actor_id`, `actor_name`, `actor_email`, `actor_type` (optional).
 *
 * Runs synchronously before the router mounts, so the `_authed` guard sees the
 * key on first navigation.
 */
export function consumeMagicLink(): void {
	if (typeof window === 'undefined' || !window.location.hash) return
	const params = new URLSearchParams(window.location.hash.slice(1))
	const key = params.get('key')
	if (!key || !key.startsWith('ank_')) return
	setApiKey(key)
	const actorId = params.get('actor_id')
	if (actorId) {
		setStoredActor({
			id: actorId,
			name: params.get('actor_name') ?? '',
			type: params.get('actor_type') ?? 'human',
			email: params.get('actor_email'),
		})
	}
	const url = window.location.pathname + window.location.search
	window.history.replaceState(null, '', url)
}
