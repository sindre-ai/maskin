import { z } from 'zod'

/**
 * Starter prompts: the few things an agent offers as one-tap openers in a new chat with it
 * ("What needs me today?"). Each entry is both the chip's label and the exact message that is
 * sent when it is tapped, so what the person reads is what is sent. That is the same rule a send
 * step in an agent intro follows (firstStepSchema), held by construction here: there is no
 * separate prompt to drift from the label.
 *
 * They live on the agent's metadata, next to its tags. Nothing is stored for an agent that has
 * none, and the clients show no chips for it.
 */
export const STARTER_PROMPT_MAX_LENGTH = 60
export const STARTER_PROMPT_MAX_COUNT = 4

/** Plain text only: a control character, which includes a newline, is rejected. */
function hasControlCharacter(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

/**
 * What a caller may write. Strict: an entry that is empty after trimming, too long, contains a
 * line break, or a fifth entry is refused instead of quietly cut. Replaces the whole list;
 * an empty list clears it.
 */
export const starterPromptListSchema = z
	.array(
		z
			.string()
			.trim()
			.min(1)
			.max(STARTER_PROMPT_MAX_LENGTH)
			.refine((text) => !hasControlCharacter(text), 'No control characters or line breaks'),
	)
	.max(STARTER_PROMPT_MAX_COUNT)

/**
 * Reads a stored list: the non-empty plain strings, trimmed, de-duplicated (case-insensitively,
 * first spelling wins) and capped. Anything else in the value is dropped, so a hand-edited blob
 * can not put an unsendable chip in front of a person.
 */
export function normalizeStarterPrompts(raw: unknown): string[] {
	if (!Array.isArray(raw)) return []
	const seen = new Set<string>()
	const prompts: string[] = []
	for (const entry of raw) {
		if (typeof entry !== 'string') continue
		const prompt = entry.trim()
		const key = prompt.toLowerCase()
		if (
			prompt.length === 0 ||
			prompt.length > STARTER_PROMPT_MAX_LENGTH ||
			hasControlCharacter(prompt) ||
			seen.has(key)
		) {
			continue
		}
		seen.add(key)
		prompts.push(prompt)
		if (prompts.length >= STARTER_PROMPT_MAX_COUNT) break
	}
	return prompts
}
