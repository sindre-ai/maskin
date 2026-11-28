import { LinkedInIntegrationError } from './errors'
import type { LinkedInMention } from './unipile-client'

const MENTION_MARKER = /\{\{(\d+)\}\}/g
const MAX_MENTIONS = 20

/**
 * Checks the tags of a post, edit, comment or reply before anything is sent. Every entry needs
 * its {{n}} marker in the text and every marker needs an entry: LinkedIn would otherwise show a
 * literal "{{1}}" or drop a tag without a word. Returns undefined for no tags, so a plain-text
 * call builds exactly the request it always did.
 */
export function validateMentions(
	text: string | undefined,
	raw: unknown,
): LinkedInMention[] | undefined {
	if (raw === undefined || raw === null) return undefined
	if (!Array.isArray(raw)) {
		throw new LinkedInIntegrationError('INVALID_INPUT', 'mentions must be a list')
	}
	if (raw.length === 0) return undefined
	if (raw.length > MAX_MENTIONS) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			`mentions takes at most ${MAX_MENTIONS} tags`,
		)
	}
	if (text === undefined) {
		throw new LinkedInIntegrationError(
			'INVALID_INPUT',
			'mentions needs text: the {{0}}, {{1}} markers in the text say where each tag goes',
		)
	}
	const mentions = raw.map((entry, i) => {
		const e = (entry ?? {}) as Record<string, unknown>
		const name = typeof e.name === 'string' ? e.name.trim() : ''
		const profileId = typeof e.profile_id === 'string' ? e.profile_id.trim() : ''
		if (!name || !profileId) {
			throw new LinkedInIntegrationError(
				'INVALID_INPUT',
				`mentions[${i}] needs a name and a profile_id`,
			)
		}
		return { name, profile_id: profileId }
	})
	const used = new Set<number>()
	for (const match of text.matchAll(MENTION_MARKER)) used.add(Number(match[1]))
	for (const n of used) {
		if (n >= mentions.length) {
			throw new LinkedInIntegrationError(
				'INVALID_INPUT',
				`The text has {{${n}}} but mentions has ${mentions.length} ${mentions.length === 1 ? 'entry' : 'entries'}. Nothing was sent.`,
			)
		}
	}
	for (let i = 0; i < mentions.length; i++) {
		if (!used.has(i)) {
			throw new LinkedInIntegrationError(
				'INVALID_INPUT',
				`mentions[${i}] has no {{${i}}} in the text, so it would tag nobody. Nothing was sent.`,
			)
		}
	}
	return mentions
}
