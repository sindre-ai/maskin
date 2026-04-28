import { createHash, randomBytes } from 'node:crypto'

/** Generate a random code verifier for PKCE (43-128 chars, base64url-encoded) */
export function generateCodeVerifier(): string {
	return randomBytes(32).toString('base64url')
}

/** Create S256 code challenge from a code verifier */
export function createS256CodeChallenge(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url')
}
