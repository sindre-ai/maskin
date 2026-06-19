/**
 * Pure helpers for the composer's `@mention` handling. Kept framework-free so
 * the matching rules can be unit-tested without a DOM.
 *
 * Mentions are matched against the *known* agent names rather than a generic
 * token grammar, so multi-word names ("@Senior Developer") resolve correctly.
 * Longest names are matched first to avoid a shorter name shadowing a longer
 * one that shares a prefix.
 */

export interface MentionableAgent {
	id: string
	name: string
}

/**
 * Returns the unique ids of agents whose names appear as `@name` in `text`.
 * Matching is case-insensitive and anchored on a word boundary before the `@`.
 */
export function parseMentionIds(text: string, agents: MentionableAgent[]): string[] {
	if (text.length === 0) return []
	const sorted = [...agents]
		.filter((a) => a.name.trim().length > 0)
		.sort((a, b) => b.name.length - a.name.length)
	const ids = new Set<string>()
	const lower = text.toLowerCase()
	for (const agent of sorted) {
		const needle = `@${agent.name.toLowerCase()}`
		let from = 0
		while (true) {
			const idx = lower.indexOf(needle, from)
			if (idx === -1) break
			// The char before `@` must be a boundary (start or whitespace) so
			// "email@host" never reads as a mention.
			const before = idx === 0 ? '' : text[idx - 1]
			if (before === '' || /\s/.test(before)) {
				ids.add(agent.id)
				break
			}
			from = idx + needle.length
		}
	}
	return Array.from(ids)
}

export interface ActiveMention {
	/** Index of the triggering `@` in the source string. */
	at: number
	/** The partial text typed after `@`, up to the caret. */
	query: string
}

/**
 * Given the textarea value and caret position, detect whether the caret sits
 * inside an in-progress `@mention` token. Returns the trigger position and the
 * partial query so the typeahead can filter, or `null` when no mention is
 * active (caret not after an `@`, or a newline intervenes).
 */
export function getActiveMention(value: string, caret: number): ActiveMention | null {
	const before = value.slice(0, caret)
	const at = before.lastIndexOf('@')
	if (at === -1) return null
	// `@` must start the line or follow whitespace.
	const preceding = at === 0 ? '' : before[at - 1]
	if (preceding !== '' && !/\s/.test(preceding)) return null
	const query = before.slice(at + 1)
	// A newline (or an absurdly long run) closes the mention.
	if (query.includes('\n') || query.length > 40) return null
	return { at, query }
}

/**
 * Replace the active `@query` token with a completed `@Name ` mention,
 * returning the new value and the caret position to place after it.
 */
export function applyMention(
	value: string,
	active: ActiveMention,
	name: string,
): { value: string; caret: number } {
	const before = value.slice(0, active.at)
	const after = value.slice(active.at + 1 + active.query.length)
	const insert = `@${name} `
	const next = before + insert + after
	return { value: next, caret: before.length + insert.length }
}
