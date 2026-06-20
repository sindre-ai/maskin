import type { SindreEvent, UserAttachmentView } from '@/lib/sindre-stream'

/**
 * Client-side persistence for the multiplayer Sindre chat.
 *
 * There is no standalone "conversation" entity on the backend yet, so a
 * conversation (its participants + full message transcript) lives in
 * localStorage, scoped per workspace. Everything funnels through the
 * `ConversationRepository` interface below so a real backend can be slotted in
 * later without touching the hook/UI — swap `localStorageRepository` for an
 * API-backed implementation and the rest of the chat keeps working.
 */

export type ChatMessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled'

export interface UserChatMessage {
	id: string
	role: 'user'
	senderId: string
	senderName: string
	text: string
	attachments?: UserAttachmentView[]
	createdAt: number
}

export interface AgentChatMessage {
	id: string
	role: 'agent'
	senderId: string
	senderName: string
	/** Streamed transcript events (text / thinking / tool_use / result). */
	events: SindreEvent[]
	status: ChatMessageStatus
	errorText?: string
	createdAt: number
}

export type ChatMessage = UserChatMessage | AgentChatMessage

export interface Conversation {
	id: string
	title: string
	/** Agent actor ids present in the room (excludes the always-on default). */
	participantIds: string[]
	messages: ChatMessage[]
	createdAt: number
	updatedAt: number
}

export interface ConversationRepository {
	list(workspaceId: string): Conversation[]
	save(workspaceId: string, conversations: Conversation[]): void
}

const STORAGE_VERSION = 'v1'

function storageKey(workspaceId: string): string {
	return `maskin.chat.${STORAGE_VERSION}.${workspaceId}`
}

/**
 * Revive a conversation loaded from storage: any agent message left
 * `streaming` (the tab closed mid-reply) can never resume — its in-flight SSE
 * is gone — so we down-grade it to `cancelled` so the UI doesn't show a
 * forever-spinning bubble.
 */
function reviveConversation(conversation: Conversation): Conversation {
	const messages = conversation.messages.map((message) =>
		message.role === 'agent' && message.status === 'streaming'
			? { ...message, status: 'cancelled' as const }
			: message,
	)
	return { ...conversation, messages }
}

export const localStorageRepository: ConversationRepository = {
	list(workspaceId) {
		if (typeof window === 'undefined') return []
		try {
			const raw = window.localStorage.getItem(storageKey(workspaceId))
			if (!raw) return []
			const parsed = JSON.parse(raw)
			if (!Array.isArray(parsed)) return []
			return (parsed as Conversation[])
				.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages))
				.map(reviveConversation)
				.sort((a, b) => b.updatedAt - a.updatedAt)
		} catch (err) {
			console.error('[chat-store] failed to load conversations', err)
			return []
		}
	},
	save(workspaceId, conversations) {
		if (typeof window === 'undefined') return
		try {
			window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(conversations))
		} catch (err) {
			console.error('[chat-store] failed to save conversations', err)
		}
	},
}

let idCounter = 0

/** Monotonic, collision-resistant id without requiring crypto in older runtimes. */
export function createId(prefix: string): string {
	idCounter += 1
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return `${prefix}_${crypto.randomUUID()}`
	}
	return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

export function createConversation(): Conversation {
	const now = Date.now()
	return {
		id: createId('conv'),
		title: 'New conversation',
		participantIds: [],
		messages: [],
		createdAt: now,
		updatedAt: now,
	}
}

/**
 * Derives a human title from the first user message — mirrors how v0/Claude
 * label history rows. Falls back to the default until the user speaks.
 */
/** Flattens an agent message's streamed events into plain markdown text. */
function agentText(message: AgentChatMessage): string {
	return message.events
		.filter((e): e is Extract<SindreEvent, { kind: 'text' }> => e.kind === 'text')
		.map((e) => e.text)
		.join('')
		.trim()
}

/** Renders a conversation transcript as portable markdown for copy/download. */
export function conversationToMarkdown(messages: ChatMessage[]): string {
	const lines: string[] = []
	for (const message of messages) {
		const speaker = message.role === 'user' ? message.senderName : message.senderName
		const body = message.role === 'user' ? message.text.trim() : agentText(message)
		if (body.length === 0) continue
		lines.push(`**${speaker}**`, '', body, '')
	}
	return lines.join('\n').trim()
}

export function deriveConversationTitle(conversation: Conversation): string {
	const firstUser = conversation.messages.find((m) => m.role === 'user') as
		| UserChatMessage
		| undefined
	if (!firstUser) return conversation.title
	const text = firstUser.text.trim().replace(/\s+/g, ' ')
	if (text.length === 0) return conversation.title
	return text.length > 48 ? `${text.slice(0, 48)}…` : text
}
