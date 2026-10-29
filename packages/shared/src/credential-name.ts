import { credentialSlug } from './credential-slug'
import { findHighConfidenceSecret } from './secret-scanner'

/** Longest credential name, in characters. */
export const CREDENTIAL_NAME_MAX_LENGTH = 64

/** Env var prefix a bring-your-own API key is injected under: this plus the slug. */
export const KEYCHAIN_BYO_APIKEY_ENV_PREFIX = 'KEYCHAIN_BYO_APIKEY_'

export type CredentialNameProblem =
	| 'empty'
	| 'too_long'
	| 'bad_characters'
	| 'no_slug'
	| 'looks_like_secret'

// Square brackets would let a name close or reopen the transcript redaction marker.
function hasBadCharacter(name: string): boolean {
	for (const ch of name) {
		const code = ch.codePointAt(0) ?? 0
		if (ch === '[' || ch === ']' || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
	}
	return false
}

/**
 * The one name rule for a bring-your-own API key, shared by the card (so the
 * message appears before a request) and the server (so the same answer holds
 * without a client). Null means the name is acceptable. Checked in order, so the
 * first problem found is the one reported.
 */
export function checkCredentialName(name: string): CredentialNameProblem | null {
	const trimmed = name.trim()
	if (trimmed.length === 0) return 'empty'
	if (trimmed.length > CREDENTIAL_NAME_MAX_LENGTH) return 'too_long'
	if (hasBadCharacter(trimmed)) return 'bad_characters'
	if (credentialSlug(trimmed) === '') return 'no_slug'
	if (findHighConfidenceSecret(trimmed)) return 'looks_like_secret'
	return null
}

export function credentialNameMessage(problem: CredentialNameProblem): string {
	switch (problem) {
		case 'empty':
			return 'Give the key a name.'
		case 'too_long':
			return `Names can be up to ${CREDENTIAL_NAME_MAX_LENGTH} characters.`
		case 'bad_characters':
			return "Names can't contain square brackets or control characters."
		case 'no_slug':
			return 'Use at least one letter or number in the name.'
		case 'looks_like_secret':
			return 'That name looks like a secret. Use a plain name for the key.'
	}
}

/** The env var a bring-your-own key is injected under, or null when the name has no usable characters. */
export function byoApiKeyEnvVar(name: string): string | null {
	const slug = credentialSlug(name)
	return slug ? `${KEYCHAIN_BYO_APIKEY_ENV_PREFIX}${slug}` : null
}

/**
 * What the transcript shows in place of a key vaulted with the ! prefix. There is no
 * known provider prefix to keep, so it carries none, and it names the env var so the
 * agent knows where to read the key. Never matches the detection table (tested).
 */
export function manualRedactionMarker(name: string): string {
	const envVar = byoApiKeyEnvVar(name)
	return `[REDACTED · vaulted as ${name}${envVar ? ` · env ${envVar}` : ''}]`
}
