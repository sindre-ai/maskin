// Pure rules for the new chat list (bet "Chat list: date groups, attention markers, filter search"):
// which pill a chat is under, which marker it carries, how rows group, and which search operators a
// query used. No React here, so the rules are tested on their own.

import type {
	ChatListFilter,
	ChatListGroupBy,
	ChatListMarker,
	ChatListSection,
} from '@/lib/analytics'
import type { ConversationListItemResponse } from '@/lib/api'
import { startOfDay } from '@/lib/conversation-groups'

export type ChatPill = ChatListFilter

export const CHAT_PILLS: Array<{ value: ChatPill; label: string }> = [
	{ value: 'all', label: 'All' },
	{ value: 'needs_you', label: 'Needs you' },
	{ value: 'unread', label: 'Unread' },
	{ value: 'working', label: 'Working' },
	{ value: 'later', label: 'Later' },
]

export const CHAT_GROUP_BY: Array<{ value: ChatListGroupBy; label: string }> = [
	{ value: 'date', label: 'Date' },
	{ value: 'status', label: 'Status' },
	{ value: 'agent', label: 'Agent' },
	{ value: 'tag', label: 'Tag' },
	{ value: 'type', label: 'Type' },
	{ value: 'none', label: 'None' },
]

/** The one marker the preview line carries: error first, then needs you, then working. */
export type PreviewMarker = 'error' | 'needs_you' | 'working' | 'none'

export function previewMarker(c: ConversationListItemResponse): PreviewMarker {
	if (c.error) return 'error'
	if (c.needs_you) return 'needs_you'
	if ((c.working?.length ?? 0) > 0) return 'working'
	return 'none'
}

/** The marker value the tracking events carry: the preview marker, else unread, else later. */
export function trackedMarker(c: ConversationListItemResponse): ChatListMarker {
	const marker = previewMarker(c)
	if (marker !== 'none') return marker
	if (c.later) return 'later'
	return c.unread_count > 0 ? 'unread' : 'none'
}

/** A chat that stopped counts as needing the person: it is the same pill, no sixth one. */
export function needsYou(c: ConversationListItemResponse): boolean {
	return !!c.error || !!c.needs_you
}

export function matchesPill(c: ConversationListItemResponse, pill: ChatPill): boolean {
	if (pill === 'later') return !!c.later
	// Later chats leave every other list until a new message brings them back.
	if (c.later) return false
	switch (pill) {
		case 'needs_you':
			return needsYou(c)
		case 'unread':
			return c.unread_count > 0
		case 'working':
			return (c.working?.length ?? 0) > 0
		default:
			return true
	}
}

export function pillCounts(rows: ConversationListItemResponse[]): Record<ChatPill, number> {
	const counts: Record<ChatPill, number> = {
		all: 0,
		needs_you: 0,
		unread: 0,
		working: 0,
		later: 0,
	}
	for (const pill of Object.keys(counts) as ChatPill[]) {
		counts[pill] = rows.filter((c) => matchesPill(c, pill)).length
	}
	return counts
}

export interface ChatGroup {
	/** Stable react key, never the label. */
	key: string
	/** The heading. Empty means no heading (Group by None). */
	label: string
	section: ChatListSection
	items: ConversationListItemResponse[]
}

type Viewer = string | null | undefined

/** Direct, Topic or Group: a pair's own line, a chat with one other, a chat with several. */
export function chatType(
	c: ConversationListItemResponse,
	viewerId: Viewer,
): 'direct' | 'topic' | 'group' {
	if (c.directPairKey) return 'direct'
	const others = c.participants.filter((p) => p.actorId !== viewerId)
	return others.length > 1 ? 'group' : 'topic'
}

function activityDate(c: ConversationListItemResponse): Date | null {
	const raw = c.lastMessageAt ?? c.createdAt
	const parsed = raw ? new Date(raw) : null
	return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
}

function dateBucket(c: ConversationListItemResponse, now: Date): 'today' | 'yesterday' | 'earlier' {
	const at = activityDate(c)
	// An unparseable or missing time sorts to Earlier rather than dropping the row.
	if (!at) return 'earlier'
	const diffDays = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
	if (diffDays <= 0) return 'today'
	return diffDays === 1 ? 'yesterday' : 'earlier'
}

function buckets(
	rows: ConversationListItemResponse[],
	order: Array<{ key: string; label: string; section: ChatListSection }>,
	pick: (c: ConversationListItemResponse) => string,
): ChatGroup[] {
	const byKey = new Map<string, ConversationListItemResponse[]>(order.map((o) => [o.key, []]))
	for (const c of rows) byKey.get(pick(c))?.push(c)
	return order
		.map((o) => ({ ...o, items: byKey.get(o.key) ?? [] }))
		.filter((g) => g.items.length > 0)
}

/**
 * Splits the rows for one Group by choice. Each chat sits in exactly one group, and no heading
 * carries a count. Rows keep the order they came in (newest activity first).
 */
export function groupChats(
	rows: ConversationListItemResponse[],
	groupBy: ChatListGroupBy,
	{ now = new Date(), viewerId }: { now?: Date; viewerId?: Viewer } = {},
): ChatGroup[] {
	if (rows.length === 0) return []

	if (groupBy === 'none') return [{ key: 'all', label: '', section: 'recent', items: rows }]

	if (groupBy === 'date') {
		return buckets(
			rows,
			[
				{ key: 'pinned', label: 'Pinned', section: 'pinned' },
				{ key: 'today', label: 'Today', section: 'today' },
				{ key: 'yesterday', label: 'Yesterday', section: 'yesterday' },
				{ key: 'earlier', label: 'Earlier', section: 'earlier' },
			],
			(c) => (c.pinned ? 'pinned' : dateBucket(c, now)),
		)
	}

	if (groupBy === 'status') {
		// Stopped chats lead the Needs you group: they need the person most.
		const ordered = [...rows].sort((a, b) => Number(!!b.error) - Number(!!a.error))
		return buckets(
			ordered,
			[
				{ key: 'pinned', label: 'Pinned', section: 'pinned' },
				{ key: 'needs_you', label: 'Needs you', section: 'needs_you' },
				{ key: 'working', label: 'Working', section: 'working' },
				{ key: 'unread', label: 'Unread', section: 'unread' },
				{ key: 'earlier', label: 'Earlier', section: 'earlier' },
			],
			(c) => {
				if (c.pinned) return 'pinned'
				if (needsYou(c)) return 'needs_you'
				if (previewMarker(c) === 'working') return 'working'
				return c.unread_count > 0 ? 'unread' : 'earlier'
			},
		)
	}

	if (groupBy === 'type') {
		return buckets(
			rows,
			[
				{ key: 'direct', label: 'Direct', section: 'type' },
				{ key: 'topic', label: 'Topic', section: 'type' },
				{ key: 'group', label: 'Group', section: 'type' },
			],
			(c) => chatType(c, viewerId),
		)
	}

	// Agent and Tag: one group per name in the order the names first appear, the unnamed last.
	const label = (c: ConversationListItemResponse): string | null => {
		if (groupBy === 'tag') return c.tags?.[0] ?? null
		const others = c.participants.filter((p) => p.actorId !== viewerId)
		return (others.find((p) => p.actorType === 'agent') ?? others[0])?.actorName ?? null
	}
	const section: ChatListSection = groupBy
	const order: ChatGroup[] = []
	const byName = new Map<string, ChatGroup>()
	let unnamed: ChatGroup | null = null
	for (const c of rows) {
		const name = label(c)
		if (name === null) {
			unnamed ??= {
				key: 'unnamed',
				label: groupBy === 'tag' ? 'No tag' : 'No agent',
				section,
				items: [],
			}
			unnamed.items.push(c)
			continue
		}
		let group = byName.get(name)
		if (!group) {
			group = { key: `${groupBy}:${name}`, label: name, section, items: [] }
			byName.set(name, group)
			order.push(group)
		}
		group.items.push(c)
	}
	return unnamed ? [...order, unnamed] : order
}

export interface OperatorToken {
	operator: 'agent' | 'from' | 'with' | 'team' | 'is'
	/** What was typed after the operator so far. */
	partial: string
	/** Where the token starts in the text, so a chosen suggestion replaces it. */
	start: number
}

/** The operator being typed at the end of the text, if the last word is one. */
export function operatorBeingTyped(text: string): OperatorToken | null {
	const start = text.lastIndexOf(' ') + 1
	const m = /^(agent|from|with|team|is):(.*)$/i.exec(text.slice(start))
	if (!m) return null
	return { operator: m[1].toLowerCase() as OperatorToken['operator'], partial: m[2], start }
}

/** The operators listed when the field has focus and is empty, each with its hint. */
export const SEARCH_OPERATOR_HINTS: Array<{ token: string; hint: string }> = [
	{ token: 'agent:', hint: 'Chats with that agent' },
	{ token: 'from:', hint: 'Chats with a message from them' },
	{ token: 'with:', hint: 'Chats they are in' },
	{ token: 'team:', hint: 'Chats tagged with a team' },
	{ token: 'is:', hint: 'unread, needs, working, later or archived' },
	{ token: '"phrase"', hint: 'Exact words' },
	{ token: '-word', hint: 'Leave out chats with that word' },
]
