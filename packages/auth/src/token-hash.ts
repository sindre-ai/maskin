import { createHash, randomBytes } from 'node:crypto'

/**
 * SHA-256 hex of a raw token or code. No salt: these values are 256-bit random, and
 * lookup must stay an indexed equality query on the hash column.
 */
export function sha256Hex(raw: string): string {
	return createHash('sha256').update(raw).digest('hex')
}

/**
 * Mints a token: `prefix` plus 43 base64url characters (32 random bytes). Pass an empty
 * prefix for an authorization code. Only `hash` is ever stored; `raw` exists in memory
 * for the length of one response.
 */
export function mintToken(prefix: string): { raw: string; hash: string } {
	const raw = `${prefix}${randomBytes(32).toString('base64url')}`
	return { raw, hash: sha256Hex(raw) }
}
