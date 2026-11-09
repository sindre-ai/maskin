import { z } from 'zod'

/** Longest tag we show, and the most per flow, agent or chat: tags are short labels, not sentences. */
export const TAG_MAX_LENGTH = 40
export const TAG_MAX_COUNT = 10

/**
 * The tags a caller may write on a flow, an agent or a chat. Strict: a tag that is empty after
 * trimming, too long, or an eleventh tag is refused instead of quietly cut.
 */
export const tagListSchema = z
	.array(z.string().trim().min(1).max(TAG_MAX_LENGTH))
	.max(TAG_MAX_COUNT)

/**
 * Reads a stored tag list: the non-empty strings, trimmed, de-duplicated (case-insensitively,
 * first spelling wins) and capped. Anything else in the value is dropped. Readers use this, not
 * a trust-the-column read, so a hand-edited blob can not 500 a page.
 */
export function normalizeTags(raw: unknown): string[] {
	if (!Array.isArray(raw)) return []
	const seen = new Set<string>()
	const tags: string[] = []
	for (const entry of raw) {
		if (typeof entry !== 'string') continue
		const tag = entry.trim().slice(0, TAG_MAX_LENGTH)
		const key = tag.toLowerCase()
		if (tag.length === 0 || seen.has(key)) continue
		seen.add(key)
		tags.push(tag)
		if (tags.length >= TAG_MAX_COUNT) break
	}
	return tags
}
