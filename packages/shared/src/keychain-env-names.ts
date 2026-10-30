import { credentialSlug } from './credential-slug'

/** Env var prefix for every credential the Keychain injects into a session. */
export const KEYCHAIN_ENV_PREFIX = 'KEYCHAIN_'

/** Provider-mode segment of the env var name for a bring-your-own API key. */
export const BYO_APIKEY_ENV_SEGMENT = 'BYO_APIKEY'

/** Provider-mode segment of the env var names for a login. */
export const BYO_LOGIN_ENV_SEGMENT = 'BYO_LOGIN'

/**
 * Env var name for a bring-your-own API key: KEYCHAIN_BYO_APIKEY_{SLUG}, so a key
 * named Coolify becomes KEYCHAIN_BYO_APIKEY_COOLIFY. Null when the display name has
 * no usable characters; such a key is not injected.
 */
export function byoApiKeyEnvName(displayName: string): string | null {
	const slug = credentialSlug(displayName)
	return slug ? `${KEYCHAIN_ENV_PREFIX}${BYO_APIKEY_ENV_SEGMENT}_${slug}` : null
}

/**
 * Env var names for a login: KEYCHAIN_BYO_LOGIN_{SLUG}_USERNAME, _PASSWORD and _EMAIL, so a
 * login named e-conomic becomes KEYCHAIN_BYO_LOGIN_E_CONOMIC_USERNAME. The email is set only
 * for a login saved with one. Null when the display name has no usable characters; such a
 * login is not injected.
 */
export function byoLoginEnvNames(
	displayName: string,
): { username: string; password: string; email: string } | null {
	const slug = credentialSlug(displayName)
	if (!slug) return null
	const base = `${KEYCHAIN_ENV_PREFIX}${BYO_LOGIN_ENV_SEGMENT}_${slug}`
	return { username: `${base}_USERNAME`, password: `${base}_PASSWORD`, email: `${base}_EMAIL` }
}
