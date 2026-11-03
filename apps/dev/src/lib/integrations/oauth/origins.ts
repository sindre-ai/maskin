/**
 * Where a connect flow was started from, so a cancel on the provider's consent
 * screen can land back on that page instead of a bare JSON error.
 *
 * The client sends a symbolic key, never a path. The server owns the path, so
 * no user-supplied string ever reaches a Location header: the key is looked up
 * here, sealed into the OAuth state, and looked up again at the callback.
 */

interface OAuthOrigin {
	/** The only provider this origin may be used with. */
	provider: string
	/** Workspace-relative frontend path to land on. */
	path: string
}

const ORIGINS: ReadonlyMap<string, OAuthOrigin> = new Map([
	['google-drive', { provider: 'google-drive', path: '/settings/integrations/google-drive' }],
])

/** The origin for `key` if it is a known key that belongs to `provider`, otherwise `undefined`. */
export function resolveOrigin(key: unknown, provider: string): OAuthOrigin | undefined {
	if (typeof key !== 'string') return undefined
	const entry = ORIGINS.get(key)
	return entry && entry.provider === provider ? entry : undefined
}
