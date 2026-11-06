import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The workspace a mat_ (Claude connector) token is pinned to, for the length of one
 * request. Set by the OAuth branch of authMiddleware and read, via getOAuthPin(), by the
 * membership helpers and by any query that lists things across a person's workspaces.
 * Undefined for every other kind of caller, so API-key behaviour does not change.
 */
export interface OAuthPin {
	workspaceId: string
	grantId: string
	clientId: string
}

const storage = new AsyncLocalStorage<OAuthPin>()

export function getOAuthPin(): OAuthPin | undefined {
	return storage.getStore()
}

/** Runs `fn` (the rest of the request) with the pin in scope. */
export function runWithOAuthPin<T>(pin: OAuthPin, fn: () => T): T {
	return storage.run(pin, fn)
}
