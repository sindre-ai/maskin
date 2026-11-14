import type { ChatSectionResponse, ConversationListItemResponse } from '@/lib/api'
import { groupByAgent } from '@/lib/conversation-agent-rows'
import { type ConversationGroup, activityMs, groupConversations } from '@/lib/conversation-groups'

/** The three automatic views beside the person's own sections. */
export type ChatListViewName = 'waiting' | 'running' | 'quiet'

export const CHAT_LIST_VIEWS: Array<{ value: ChatListViewName; label: string }> = [
	{ value: 'waiting', label: 'Waiting on you' },
	{ value: 'running', label: 'Running' },
	{ value: 'quiet', label: 'Quiet' },
]

/** A chat leaves the main list after this many days without a message. One rule for web and iPhone. */
export const QUIET_DAYS = 7

/** What waits on the viewer in one chat: unread mentions plus open cards. New messages alone add 0. */
export function waitingCount(c: ConversationListItemResponse): number {
	return (c.mentions_unread ?? 0) + (c.open_cards ?? 0)
}

/** New messages with nothing for the viewer: shown as a hollow dot, never as a number. */
export function hasQuietNews(c: ConversationListItemResponse): boolean {
	return c.unread_count > 0 && waitingCount(c) === 0 && !c.directPairKey
}

/** The number on a row's badge. A direct chat with an agent still counts every message. */
export function badgeCount(c: ConversationListItemResponse): number {
	return c.directPairKey ? c.unread_count : waitingCount(c)
}

/** Whole days since the chat's last message, for "Last message N days ago". */
export function daysQuiet(c: ConversationListItemResponse, now: Date = new Date()): number {
	return Math.max(0, Math.floor((now.getTime() - activityMs(c)) / 86_400_000))
}

/** The line under a row in a view that says why the chat is there. */
export function viewReason(
	view: ChatListViewName,
	c: ConversationListItemResponse,
	now: Date = new Date(),
): string | null {
	if (view === 'running') return 'Agent running now'
	if (view === 'quiet') {
		const days = daysQuiet(c, now)
		return `Last message ${days} ${days === 1 ? 'day' : 'days'} ago`
	}
	const text = c.card_text?.trim()
	if ((c.mentions_unread ?? 0) > 0) return text ? `Mentions you: "${text}"` : 'Mentions you'
	if ((c.open_cards ?? 0) > 0) return text ? `Asks you: "${text}"` : 'Asks you'
	return null
}

/** The key of a custom section's group; the list reads the section back from it. */
export const SECTION_KEY_PREFIX = 'section:'

export function sectionIdOfGroup(groupKey: string): string | null {
	return groupKey.startsWith(SECTION_KEY_PREFIX) ? groupKey.slice(SECTION_KEY_PREFIX.length) : null
}

/**
 * The default list with the person's sections: Pinned (chats in no section), then each section in
 * order, then Rooms and Agents. A chat in a section shows there and nowhere else, whatever its pin
 * or agent; pinned chats come first inside a section. An empty section stays, so it can take a drop.
 * A chat the list has not loaded yet is left out of its section until it arrives.
 */
export function groupWithSections(
	conversations: ConversationListItemResponse[],
	sections: ChatSectionResponse[],
	selfId: string | undefined,
	now: Date = new Date(),
	/** `agents` folds each agent's chats into one row; `recent` is the flat newest-first list. */
	mode: 'agents' | 'recent' = 'agents',
): ConversationGroup[] {
	const byId = new Map(conversations.map((c) => [c.id, c]))
	const placed = new Set<string>()
	const sectionGroups: ConversationGroup[] = [...sections]
		.sort((a, b) => a.position - b.position)
		.map((section) => {
			const items: ConversationListItemResponse[] = []
			for (const id of section.conversationIds) {
				const c = byId.get(id)
				// A chat sits in one section: the first one that names it wins.
				if (!c || placed.has(id)) continue
				placed.add(id)
				items.push(c)
			}
			return {
				key: `${SECTION_KEY_PREFIX}${section.id}`,
				label: section.name,
				// Pinned first, the rest keep the order the person gave them.
				items: [...items.filter((c) => c.pinned), ...items.filter((c) => !c.pinned)],
			}
		})
	const rest = conversations.filter((c) => !placed.has(c.id))
	if (mode === 'recent') {
		return [...sectionGroups, ...groupConversations(rest, { mode: 'recent', now })]
	}
	const base = groupByAgent(rest, selfId, now)
	const rooms = base.filter((g) => g.key === 'rooms')
	const pinned = base.filter((g) => g.key === 'pinned')
	const agents = base.filter((g) => g.key === 'agents')
	return [...pinned, ...sectionGroups, ...rooms, ...agents]
}

/** Every chat is listed somewhere: a section, a room, Pinned or an agent row. Used by the tests to
 *  prove no chat falls out of every view. */
export function unlistedChats(
	conversations: ConversationListItemResponse[],
	groups: ConversationGroup[],
): ConversationListItemResponse[] {
	const listed = new Set<string>()
	for (const g of groups) {
		for (const c of g.items) listed.add(c.id)
		for (const e of g.entries ?? []) {
			if (e.kind === 'agent') for (const c of e.conversations) listed.add(c.id)
		}
	}
	return conversations.filter((c) => !listed.has(c.id))
}
