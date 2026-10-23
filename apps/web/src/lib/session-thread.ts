import { type ActivityStep, describeEvent } from '@/components/agents/session-log-transcript'
import type { ConversationThread } from '@/hooks/use-conversation-threads'
import type { MessageResponse, SessionLogResponse, SessionResponse } from '@/lib/api'
import { parseChatLine } from '@/lib/chat-stream'

/**
 * What a background run is called: its trigger's name. A run with no trigger (or whose
 * trigger is gone) falls back to the first line of its prompt.
 */
export function backgroundTitle(triggerName: string | undefined, actionPrompt: string): string {
	const name = triggerName?.trim()
	if (name) return name
	const firstLine = actionPrompt
		.split('\n')
		.find((l) => l.trim().length > 0)
		?.trim()
	if (!firstLine) return 'Untitled session'
	return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
}

const continuesOf = (s: SessionResponse): string | null => {
	const id = s.config?.continues_session_id
	return typeof id === 'string' ? id : null
}

/**
 * Background runs as threads, the way a chat shows its handed-off work: a follow-up the
 * person wrote after a run ended carries on in that run's thread instead of being a row of
 * its own, and the thread shows the newest session's state. Oldest run first.
 */
export function buildBackgroundThreads(
	sessions: SessionResponse[],
	actorName: string,
): ConversationThread[] {
	const byId = new Map(sessions.map((s) => [s.id, s]))
	const rootOf = (s: SessionResponse): SessionResponse => {
		const from = continuesOf(s)
		const parent = from ? byId.get(from) : undefined
		return parent ? rootOf(parent) : s
	}
	const threads = new Map<string, ConversationThread>()
	const byAge = [...sessions].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
	for (const s of byAge) {
		const root = rootOf(s)
		const thread = threads.get(root.id)
		if (!thread) {
			threads.set(root.id, {
				id: s.id,
				status: s.status,
				actorId: s.actorId,
				actorName,
				actionPrompt: s.actionPrompt,
				createdAt: s.createdAt,
				startedAt: s.startedAt,
				completedAt: s.completedAt,
				durationMs: null,
				result: s.result,
				currentActivity: s.currentActivity,
				depends_on_session_ids: [],
				awaiting: null,
				messageId: null,
				sessionIds: [s.id],
				followUps: [],
				latestId: s.id,
			})
			continue
		}
		threads.set(root.id, {
			...thread,
			status: s.status,
			result: s.result,
			completedAt: s.completedAt,
			currentActivity: s.currentActivity,
			sessionIds: [...thread.sessionIds, s.id],
			followUps: [
				...thread.followUps,
				{ id: s.id, actionPrompt: s.actionPrompt, createdAt: s.createdAt },
			],
			latestId: s.id,
		})
	}
	return [...threads.values()]
}

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
		/** Who a message was typed by, when its turn says; unknown ids fall back to `me`. */
		resolveActor?: (id: string) => Party | undefined
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
				const typedBy = event.actorId ? ctx.resolveActor?.(event.actorId) : undefined
				items.push({ message: make(typedBy ?? ctx.me, text, log.createdAt, null), steps: [] })
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
