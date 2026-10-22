import { type ActivityStep, describeEvent } from '@/components/agents/session-log-transcript'
import type { MessageResponse, SessionLogResponse } from '@/lib/api'
import { parseChatLine } from '@/lib/chat-stream'

export interface ThreadChatItem {
	message: MessageResponse
	/** What the agent did before it wrote this message: the dropdown under its name. */
	steps: ActivityStep[]
}

export interface ThreadChat {
	items: ThreadChatItem[]
	/** Steps taken since the last message: the turn that is still going. */
	liveSteps: ActivityStep[]
}

interface Party {
	id: string
	name: string
	type: 'human' | 'agent'
}

/**
 * Reads a sub-session's log as a chat: the prompt it was handed, then each reply the
 * agent wrote and each message a person sent into it, so the thread can be drawn with
 * the same bubbles as the main chat. Ids are negative because these are not stored
 * messages: the bubble then offers no edit or retry for them.
 */
export function buildThreadChat(
	logs: SessionLogResponse[],
	ctx: {
		conversationId: string
		sessionId: string
		agent: Party
		me: Party
		prompt: { author: Party; content: string; createdAt: string | null }
	},
): ThreadChat {
	let nextId = -1
	const make = (
		party: Party,
		content: string,
		createdAt: string | null,
		sessionId: string | null,
	): MessageResponse => ({
		id: nextId--,
		conversationId: ctx.conversationId,
		actorId: party.id,
		actorName: party.name,
		actorType: party.type,
		kind: 'message',
		content,
		metadata: null,
		sessionId,
		createdAt,
		editedAt: null,
	})

	const items: ThreadChatItem[] = []
	if (ctx.prompt.content.trim()) {
		items.push({
			message: make(ctx.prompt.author, ctx.prompt.content.trim(), ctx.prompt.createdAt, null),
			steps: [],
		})
	}

	let steps: ActivityStep[] = []
	// The first user envelope is the prompt again, wrapped in the startup text: skip it.
	let sawPrompt = false
	for (const log of logs) {
		if (log.stream === 'stderr') {
			steps.push({ id: `${log.id}-stderr`, kind: 'error', text: log.content.slice(0, 100) })
			continue
		}
		if (log.stream !== 'stdout') continue
		const events = parseChatLine(log.content, { includeUser: true })
		events.forEach((event, index) => {
			if (event.kind === 'user') {
				if (event.isRetry) return
				if (!sawPrompt) {
					sawPrompt = true
					return
				}
				const text = event.text.trim()
				if (!text) return
				items.push({ message: make(ctx.me, text, log.createdAt, null), steps: [] })
				steps = []
				return
			}
			if (event.kind === 'result') {
				const text = event.text?.trim()
				if (text) {
					items.push({
						message: make(ctx.agent, text, log.createdAt, ctx.sessionId),
						steps,
					})
				}
				steps = []
				return
			}
			if (event.kind === 'system' || event.kind === 'debug') return
			const summary = describeEvent(event)
			if (summary === null) return
			steps.push({ id: `${log.id}-${index}`, kind: event.kind, text: summary })
		})
	}
	return { items, liveSteps: steps }
}
