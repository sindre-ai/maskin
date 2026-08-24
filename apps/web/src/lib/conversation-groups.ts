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

export type ConversationGroupMode = 'default' | 'archived' | 'search'

interface GroupOptions {
	/** `archived` collapses everything into one ARCHIVED group, `search` into
	 *  one "N results" group — both mirror the v2 mockup (line 525). */
	mode?: ConversationGroupMode
	/** Injectable clock so the bucketing is testable across day boundaries. */
	now?: Date
}

/**
 * Buckets a conversation list into the v2 mockup's group rail: PINNED first,
 * then TODAY / YESTERDAY / THIS WEEK / EARLIER off `lastMessageAt ?? createdAt`.
 * Empty groups are dropped so the rail never shows a bare header.
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

	const today = startOfDay(now)
	const buckets: Record<string, ConversationListItemResponse[]> = {
		pinned: [],
		today: [],
		yesterday: [],
		week: [],
		earlier: [],
	}

	for (const c of conversations) {
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
	return order
		.filter(([key]) => (buckets[key] ?? []).length > 0)
		.map(([key, label]) => ({ key, label, items: buckets[key] as ConversationListItemResponse[] }))
}
