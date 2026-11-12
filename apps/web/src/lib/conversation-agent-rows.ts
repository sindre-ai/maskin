import type { ConversationListItemResponse } from '@/lib/api'
import type { ConversationGroup } from '@/lib/conversation-groups'

type Participant = ConversationListItemResponse['participants'][number]

/** One top-level row of the Agents view. */
export type ConversationListEntry =
	| { kind: 'chat'; key: string; conversation: ConversationListItemResponse }
	| {
			kind: 'agent'
			key: string
			agent: Participant
			/** The agent's chats, newest first. */
			conversations: ConversationListItemResponse[]
			/** Unread messages summed over the chats. */
			unread: number
	  }

/** When a chat was last active, as epoch ms. A missing or unparseable time sorts last. */
export function activityMs(c: ConversationListItemResponse): number {
	const raw = c.lastMessageAt ?? c.createdAt
	const ms = raw ? new Date(raw).getTime() : Number.NaN
	return Number.isNaN(ms) ? 0 : ms
}

/** The one agent a chat is with: the viewer plus exactly one agent. Anything else (a person, several
 *  actors, nobody) belongs to no agent and is a row of its own. */
export function agentOf(c: ConversationListItemResponse, selfId: string | undefined) {
	const others = c.participants.filter((p) => p.actorId !== selfId)
	return others.length === 1 && others[0].actorType === 'agent' ? others[0] : null
}

/**
 * The Agents view's rows: one per agent with more than one chat (its chats folded under it), a plain
 * row for an agent's only chat, a group chat or a chat with a person. Newest activity first.
 */
export function buildAgentEntries(
	conversations: ConversationListItemResponse[],
	selfId: string | undefined,
): ConversationListEntry[] {
	const byAgent = new Map<string, { agent: Participant; chats: ConversationListItemResponse[] }>()
	const entries: Array<{ at: number; entry: ConversationListEntry }> = []
	for (const c of conversations) {
		const agent = agentOf(c, selfId)
		if (!agent) {
			entries.push({ at: activityMs(c), entry: { kind: 'chat', key: c.id, conversation: c } })
			continue
		}
		const group = byAgent.get(agent.actorId)
		if (group) group.chats.push(c)
		else byAgent.set(agent.actorId, { agent, chats: [c] })
	}
	for (const { agent, chats } of byAgent.values()) {
		const sorted = [...chats].sort((a, b) => activityMs(b) - activityMs(a))
		if (sorted.length === 1) {
			entries.push({
				at: activityMs(sorted[0]),
				entry: { kind: 'chat', key: sorted[0].id, conversation: sorted[0] },
			})
			continue
		}
		entries.push({
			at: activityMs(sorted[0]),
			entry: {
				kind: 'agent',
				key: `agent:${agent.actorId}`,
				agent,
				conversations: sorted,
				unread: sorted.reduce((sum, c) => sum + c.unread_count, 0),
			},
		})
	}
	return entries.sort((a, b) => b.at - a.at).map((e) => e.entry)
}

/** The Agents view's groups: pinned chats on top as plain rows, then the agent rows. A pinned chat
 *  leaves its agent's fold, so it is listed once. */
export function groupByAgent(
	conversations: ConversationListItemResponse[],
	selfId: string | undefined,
): ConversationGroup[] {
	const pinned = conversations.filter((c) => c.pinned).sort((a, b) => activityMs(b) - activityMs(a))
	const entries = buildAgentEntries(
		conversations.filter((c) => !c.pinned),
		selfId,
	)
	return [
		{ key: 'pinned', label: 'Pinned', items: pinned },
		{
			key: 'agents',
			label: 'Agents',
			items: entries.flatMap((e) => (e.kind === 'chat' ? [e.conversation] : e.conversations)),
			entries,
		},
	].filter((g) => g.items.length > 0)
}
