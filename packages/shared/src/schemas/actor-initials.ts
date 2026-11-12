import { z } from 'zod'

/** The most letters an agent can put on its avatar. */
export const ACTOR_INITIALS_MAX_LENGTH = 3

const INITIALS_PATTERN = /^[\p{L}\p{N}]+$/u

/**
 * The letters a caller may write on an agent's avatar: 1 to 3 letters or digits, no spaces. Strict:
 * anything else is refused instead of quietly cut. An empty string (after trimming) clears the
 * setting, so it is allowed through here and handled by `normalizeActorInitials`. Saved upper case.
 */
export const actorInitialsSchema = z
	.string()
	.trim()
	.max(ACTOR_INITIALS_MAX_LENGTH)
	.refine((text) => text === '' || INITIALS_PATTERN.test(text), 'Use letters or digits only')

/**
 * Reads initials, from a write or from a stored value: trimmed and upper-cased, or null when there
 * is nothing usable (empty, too long, or not letters and digits). Readers use this, not a
 * trust-the-column read, so a hand-edited blob can not put odd text on an avatar.
 */
export function normalizeActorInitials(raw: unknown): string | null {
	if (typeof raw !== 'string') return null
	const initials = raw.trim().toUpperCase()
	if (initials.length === 0 || initials.length > ACTOR_INITIALS_MAX_LENGTH) return null
	return INITIALS_PATTERN.test(initials) ? initials : null
}
