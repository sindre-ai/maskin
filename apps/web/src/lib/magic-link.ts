import { setApiKey } from './auth'

/**
 * Consumes an API key from the URL fragment (e.g. `#key=ank_...`) and stores
 * it in localStorage, then strips the fragment from the URL. Used so that MCP
 * `get_started` can return a one-click link that auto-authenticates the user.
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
	const url = window.location.pathname + window.location.search
	window.history.replaceState(null, '', url)
}
