import { AUTH_TAG_LENGTH, IV_LENGTH, decrypt, open, seal } from '../../crypto'

/** The payload the connect route seals into the OAuth `state` parameter. */
export interface OAuthStatePayload {
	workspaceId: string
	actorId: string
	ts: number
	nonce: string
	/** Present only for generic-OAuth2 providers that use PKCE. */
	codeVerifier?: string
}

/**
 * Compact envelope for the OAuth `state` parameter: the same AES-256-GCM seal
 * as `crypto.ts`, concatenated as `iv || authTag || ciphertext` and base64url'd
 * rather than `hex:hex:hex` — roughly 45% of the size.
 *
 * Length is a correctness constraint here, not a nicety: `state` round-trips
 * through provider login flows that park it in cookies with hard size limits.
 * See the file-level note in `providers/ubersuggest/auth.ts` for the case that
 * forced this.
 */
export function encodeState(payload: OAuthStatePayload): string {
	const { iv, authTag, encrypted } = seal(JSON.stringify(payload))
	return Buffer.concat([iv, authTag, encrypted]).toString('base64url')
}

/**
 * Decode a state produced by {@link encodeState}.
 *
 * TODO(remove after 2026-09-30): the `hex:hex:hex` branch exists only so flows
 * already in flight across the deploy that introduced this codec (state is
 * valid for 10 minutes) complete instead of failing with an opaque "Invalid
 * state parameter" after the user has already approved consent.
 */
export function decodeState<T = OAuthStatePayload>(state: string): T {
	if (state.includes(':')) return JSON.parse(decrypt(state)) as T

	const buf = Buffer.from(state, 'base64url')
	if (buf.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
		throw new Error('Invalid state format')
	}
	return JSON.parse(
		open(
			buf.subarray(0, IV_LENGTH),
			buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH),
			buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH),
		),
	) as T
}
