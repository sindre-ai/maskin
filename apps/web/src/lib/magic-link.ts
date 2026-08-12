import { setApiKey, setStoredActor } from './auth'

/**
 * Applies credentials carried in a magic-link fragment (`#key=ank_...&actor_id=...`)
 * to the session and returns true when a valid key was present. Extracted from
 * consumeMagicLink so the Tauri iOS shell can reuse it for deep-link handoffs that
 * arrive as an external URL rather than the webview's own location.
 *
 * Supported params: `key` (required, must start with `ank_`), `actor_id`,
 * `actor_name`, `actor_email`, `actor_type` (optional).
 */
export function applyMagicLinkFragment(hash: string): boolean {
	const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
	const key = params.get('key')
	if (!key || !key.startsWith('ank_')) return false
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
	return true
}

/**
 * Consumes credentials from the URL fragment and stores them in localStorage,
 * then strips the fragment. Used so MCP `get_started` can return a one-click
 * link that auto-authenticates the user and populates their profile.
 *
 * Runs synchronously before the router mounts, so the `_authed` guard sees the
 * key on first navigation.
 */
export function consumeMagicLink(): void {
	if (typeof window === 'undefined' || !window.location.hash) return
	if (!applyMagicLinkFragment(window.location.hash)) return
	const url = window.location.pathname + window.location.search
	window.history.replaceState(null, '', url)
}
