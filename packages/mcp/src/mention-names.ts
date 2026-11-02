export type MentionParticipant = { actorId: string; actorName: string }

export type MentionNameResolution = {
	/** Actor IDs for names that matched exactly one participant. */
	resolved: string[]
	/** Names that matched nobody, or matched more than one participant. */
	unresolved: Array<{ name: string; reason: 'not_in_conversation' | 'ambiguous' }>
}

const normalize = (name: string) => name.trim().replace(/^@/, '').trim().toLowerCase()

/**
 * Resolves human-readable names against a conversation's participants.
 * Matches the full display name first, then a first name or whole-word
 * prefix that is unique among participants ("Magnus" for "Magnus Hansen").
 * Never guesses: a name that fits several participants is reported as
 * ambiguous rather than picking one, because a wrong mention wakes the
 * wrong agent.
 */
export function resolveMentionNames(
	names: string[],
	participants: MentionParticipant[],
): MentionNameResolution {
	const resolved: string[] = []
	const unresolved: MentionNameResolution['unresolved'] = []
	for (const raw of names) {
		const wanted = normalize(raw)
		if (!wanted) continue
		const exact = participants.filter((p) => normalize(p.actorName) === wanted)
		const matches =
			exact.length > 0
				? exact
				: participants.filter((p) => {
						const full = normalize(p.actorName)
						return full.startsWith(`${wanted} `)
					})
		if (matches.length === 1) {
			const id = matches[0]?.actorId
			if (id && !resolved.includes(id)) resolved.push(id)
		} else {
			unresolved.push({
				name: raw,
				reason: matches.length === 0 ? 'not_in_conversation' : 'ambiguous',
			})
		}
	}
	return { resolved, unresolved }
}
