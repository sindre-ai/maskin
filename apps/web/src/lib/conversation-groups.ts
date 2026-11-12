import type { ConversationListItemResponse } from '@/lib/api'

/** Midnight of `d` in the viewer's local timezone, as epoch ms. */
export function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export interface ConversationGroup {
	/** Stable react key — never the (localised) label. */
	key: string
	/** Rendered as an `.eyebrow` mono uppercase label. */
	label: string
	items: ConversationListItemResponse[]
}

export type ConversationGroupMode = 'default' | 'archived' | 'search' | 'unread'

interface GroupOptions {
	/** `archived` collapses everything into one ARCHIVED group, `search` into
	 *  one "N results" group — both mirror the v2 mockup (line 525). */
	mode?: ConversationGroupMode
	/** Injectable clock so the bucketing is testable across day boundaries. */
	now?: Date
}

/**
 * Buckets a conversation list into the v2 mockup's group rail: direct messages
 * first, then PINNED, then TODAY / YESTERDAY / THIS WEEK / EARLIER off
 * `lastMessageAt ?? createdAt`. Empty groups are dropped so the rail never
 * shows a bare header.
 *
 * A direct message (DM) is a chat marked with `directPairKey`, never one picked
 * out by its title or its two participants: a topical chat with one agent has
 * both too. The archived and search lists stay flat.
 */
export function groupConversations(
	conversations: ConversationListItemResponse[],
	{ mode = 'default', now = new Date() }: GroupOptions = {},
): ConversationGroup[] {
	if (conversations.length === 0) return []

	if (mode === 'archived') {
		return [{ key: 'archived', label: 'Archived', items: conversations }]
	}
	if (mode === 'search') {
		const label = `${conversations.length} ${conversations.length === 1 ? 'result' : 'results'}`
		return [{ key: 'results', label, items: conversations }]
	}

	// One pinned row per person or agent, above everything else. Each chat is placed once.
	const direct = conversations.filter((c) => c.directPairKey)
	const topical = conversations.filter((c) => !c.directPairKey)
	const directGroup: ConversationGroup = {
		key: 'direct',
		label: 'Direct messages',
		items: direct,
	}

	if (mode === 'unread') {
		// The v11 list: what waits on the viewer first, everything else under Earlier.
		const pinned = topical.filter((c) => c.pinned)
		const rest = topical.filter((c) => !c.pinned)
		return [
			directGroup,
			{ key: 'pinned', label: 'Pinned', items: pinned },
			{ key: 'unread', label: 'Unread', items: rest.filter((c) => c.unread_count > 0) },
			{ key: 'earlier', label: 'Earlier', items: rest.filter((c) => c.unread_count === 0) },
		].filter((g) => g.items.length > 0)
	}

	const today = startOfDay(now)
	const buckets: Record<string, ConversationListItemResponse[]> = {
		pinned: [],
		today: [],
		yesterday: [],
		week: [],
		earlier: [],
	}

	for (const c of topical) {
		if (c.pinned) {
			buckets.pinned.push(c)
			continue
		}
		const raw = c.lastMessageAt ?? c.createdAt
		const parsed = raw ? new Date(raw) : null
		// An unparseable/absent timestamp sorts to EARLIER rather than
		// silently dropping the row out of the list entirely.
		if (!parsed || Number.isNaN(parsed.getTime())) {
			buckets.earlier.push(c)
			continue
		}
		const diffDays = Math.round((today - startOfDay(parsed)) / 86_400_000)
		if (diffDays <= 0) buckets.today.push(c)
		else if (diffDays === 1) buckets.yesterday.push(c)
		else if (diffDays <= 7) buckets.week.push(c)
		else buckets.earlier.push(c)
	}

	const order: Array<[string, string]> = [
		['pinned', 'Pinned'],
		['today', 'Today'],
		['yesterday', 'Yesterday'],
		['week', 'This week'],
		['earlier', 'Earlier'],
	]
	return [
		directGroup,
		...order.map(
			([key, label]): ConversationGroup => ({
				key,
				label,
				items: buckets[key] as ConversationListItemResponse[],
			}),
		),
	].filter((g) => g.items.length > 0)
}
