import { z } from 'zod'

/**
 * Starter prompts: the few things an agent offers as one-tap openers in a new chat with it
 * ("What needs me today?"). Each entry is both the chip's label and the exact message that is
 * put in the box when it is tapped, so what the person reads is what is sent. That is the same
 * rule a send step in an agent intro follows (firstStepSchema), held by construction here: there
 * is no separate prompt to drift from the label.
 *
 * They live on the agent's metadata, next to its tags. Nothing is stored for an agent that has
 * none, and the clients show no chips for it.
 *
 * Writing is strict (a bad entry is refused, never quietly cut); reading is tolerant (a stale or
 * hand-edited value is cleaned up and never fails a page). The Swift reader in
 * `apps/apple/Sources/MaskinCore/Chats/StarterPrompts.swift` is a port of `normalizeStarterPrompts`
 * and both are held to the same vectors (`starter-prompts.test.ts`, `StarterPromptsTests.swift`).
 * Change one, change the other.
 */
export const STARTER_PROMPT_MAX_LENGTH = 60
export const STARTER_PROMPT_MAX_COUNT = 4

/**
 * Plain text only. A control character is rejected: C0 (includes tab and newline), DEL, C1
 * (includes U+0085, the "next line" control) and the Unicode line and paragraph separators. All
 * of them can break the one-line chip or hide a line break inside it.
 */
function hasControlCharacter(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
			return true
		}
	}
	return false
}

/**
 * What two prompts are compared by: lower case, with the final sigma folded to the ordinary one.
 * `toLowerCase` picks "ς" at the end of a word and "σ" elsewhere; Swift's `lowercased()` always
 * picks "σ". Folding them makes "ΑΣ" and "ας" one prompt on both clients.
 */
export function starterPromptKey(prompt: string): string {
	return prompt.toLowerCase().replace(/ς/g, 'σ')
}

/**
 * What a caller may write. Strict: an entry that is empty after trimming, too long, contains a
 * line break or other control character, a repeat of an earlier entry (case-insensitively), or a
 * fifth entry is refused instead of quietly cut. Replaces the whole list; an empty list clears it.
 *
 * `.trim()` is the JavaScript one (spaces, no-break spaces, U+FEFF, line terminators). The Swift
 * reader trims the same set.
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
	.superRefine((prompts, ctx) => {
		const seen = new Set<string>()
		prompts.forEach((prompt, index) => {
			const key = starterPromptKey(prompt)
			if (seen.has(key)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [index],
					message: 'Starter prompts must be different from each other, ignoring capitals',
				})
			}
			seen.add(key)
		})
	})

/**
 * Reads a stored list: the non-empty plain strings, trimmed, de-duplicated (first spelling wins)
 * and capped. Anything else in the value is dropped, so a hand-edited blob can not put an
 * unsendable chip in front of a person. Unlike the write schema it never refuses: a repeat is
 * dropped here only because a value that was not written through the API can hold one.
 */
export function normalizeStarterPrompts(raw: unknown): string[] {
	if (!Array.isArray(raw)) return []
	const seen = new Set<string>()
	const prompts: string[] = []
	for (const entry of raw) {
		if (typeof entry !== 'string') continue
		const prompt = entry.trim()
		const key = starterPromptKey(prompt)
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

/**
 * The text of a message box after a starter is tapped. An empty box takes the prompt; a box with
 * text keeps it and gets the prompt after it, one space between. A tap never erases what the
 * person already typed. Used by every surface that has chips, with the same rule on iOS
 * (`ChatComposerModel.addStarter`).
 */
export function withStarterPrompt(current: string, prompt: string): string {
	return current.trim().length === 0 ? prompt : `${current.trimEnd()} ${prompt}`
}
