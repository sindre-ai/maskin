import type { ConversationListItemResponse } from '@/lib/api'
import type { ConversationListEntry } from '@/lib/conversation-agent-rows'

/** Midnight of `d` in the viewer's local timezone, as epoch ms. */
export function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** When a chat was last active, as epoch ms. A missing or unparseable time sorts last. */
export function activityMs(c: ConversationListItemResponse): number {
	const raw = c.lastMessageAt ?? c.createdAt
	const ms = raw ? new Date(raw).getTime() : Number.NaN
	return Number.isNaN(ms) ? 0 : ms
}

export interface ConversationGroup {
	/** Stable react key — never the (localised) label. */
	key: string
	/** Rendered as an `.eyebrow` mono uppercase label. */
	label: string
	/** Every chat in the group. */
	items: ConversationListItemResponse[]
	/** What the group draws when it is not one row per chat (the Agents view folds an agent's
	 *  chats into one row). The header counts these. */
	entries?: ConversationListEntry[]
}

/** A flow's room stays in the list this long after its last message, unless it is unread, pinned or working. */
const FLOW_ROOM_QUIET_DAYS = 14

/**
 * Whether a room belongs in the Rooms group. A free-form room always does: a person made it on
 * purpose and it never leaves for being quiet. A flow's room shows only with a message in the
 * last 14 days, unread, working or pinned, and a flow with no messages is hidden like an empty
 * direct message. A hidden room is still found by search.
 */
export function isRoomListed(c: ConversationListItemResponse, now: Date = new Date()): boolean {
	if (c.roomKind === 'free') return true
	if (c.roomKind !== 'flow') return false
	// The row has no message count; the preview is empty exactly when nobody has written yet.
	if (c.snippet === null) return false
	if (c.unread_count > 0 || c.pinned || c.working_actor_ids.length > 0) return true
	const last = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : Number.NaN
	return !Number.isNaN(last) && now.getTime() - last < FLOW_ROOM_QUIET_DAYS * 86_400_000
}

export type ConversationGroupMode = 'default' | 'archived' | 'search' | 'unread' | 'recent'

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
 * Rooms come before all of them (see isRoomListed). A direct message (DM) is a chat marked with `directPairKey`, never one picked
 * out by its title or its two participants: a topical chat with one agent has
 * both too. The archived and search lists stay flat. `recent` is the Recent view: one
 * newest-first list, pinned on top, direct messages in the time buckets like any other chat.
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

	// Rooms sit above everything else, a quiet flow's room is left out of the list, and each chat
	// is placed once. Then one pinned row per person or agent.
	const roomGroup: ConversationGroup = {
		key: 'rooms',
		label: 'Rooms',
		items: conversations.filter((c) => isRoomListed(c, now)),
	}
	const rest = conversations.filter((c) => !c.roomKind)
	const recent = mode === 'recent'
	const direct = recent ? [] : rest.filter((c) => c.directPairKey)
	const topical = recent
		? [...rest].sort((a, b) => activityMs(b) - activityMs(a))
		: rest.filter((c) => !c.directPairKey)
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
			roomGroup,
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
		roomGroup,
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
