/**
 * Stamped metadata for a GitHub App installation token. Used by the error
 * tagger to tell "token was fine at session start but expired mid-session"
 * apart from a generic 401. Kept in a dedicated module so the mint / refresh
 * path (auth.ts) and the response-tagging path (error-tagger.ts) do not both
 * edit the same function.
 */

export interface TokenMetadata {
	token: string
	/** Wall-clock time the token was minted. */
	mintedAt: Date
	/** GitHub App installation ID this token was minted against. */
	installationId: string
}

/**
 * GitHub App installation tokens live for exactly 1 hour with no refresh
 * token. We flag anything older than ~50 minutes as "possibly stale" so a
 * 401 landing after that mark can be tagged `token-expired-mid-session`
 * instead of the generic `401-unauth`.
 */
export const TOKEN_STALE_THRESHOLD_MS = 50 * 60 * 1000

export function stampTokenMetadata(token: string, installationId: string): TokenMetadata {
	return { token, mintedAt: new Date(), installationId }
}

export function getTokenAgeMs(meta: TokenMetadata, now: Date = new Date()): number {
	return now.getTime() - meta.mintedAt.getTime()
}

export function getTokenAgeSeconds(meta: TokenMetadata, now: Date = new Date()): number {
	return Math.floor(getTokenAgeMs(meta, now) / 1000)
}

export function isTokenPossiblyStale(meta: TokenMetadata, now: Date = new Date()): boolean {
	return getTokenAgeMs(meta, now) > TOKEN_STALE_THRESHOLD_MS
}
