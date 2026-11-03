/** Longest slug, so the env var name stays well under any shell or API limit. */
export const CREDENTIAL_SLUG_MAX_LENGTH = 48

/**
 * Turns a credential display name into the identifier used in its env var name.
 * Uppercase, every run of characters outside A-Z and 0-9 becomes one underscore,
 * leading and trailing underscores are trimmed, capped at 48 characters.
 * Returns an empty string for a name with nothing usable (emoji or punctuation only),
 * which callers must treat as "no env var".
 *
 * One function for the card preview and the server, so both give the same answer.
 */
export function credentialSlug(displayName: string): string {
	return displayName
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, CREDENTIAL_SLUG_MAX_LENGTH)
		.replace(/_+$/, '')
}
