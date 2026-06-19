import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import type { SindreEvent, UserAttachmentView } from '@/lib/sindre-stream'

/**
 * Persistence for the multiplayer Sindre chat.
 *
 * The repository interface is async so the API-backed implementation
 * (`apiConversationRepository`) can talk to `/api/conversations` while the
 * client-only `localStorageRepository` keeps working from `localStorage`.
 * Hook / UI code uses the interface; swapping repos is a one-line change in
 * `useSindreConversation`.
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
	/**
	 * Event id (`events.id` bigserial) once the message has been persisted via
	 * `/api/conversations/:id/messages`. Local-only messages omit this.
	 */
	remoteId?: number
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
	/**
	 * Event id (`events.id` bigserial) once the agent reply has been persisted
	 * as a `commented` event on the conversation object. Live-streamed in-memory
	 * messages omit this until the hydration refresh after session-complete.
	 */
	remoteId?: number
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

export interface CreateConversationDraft {
	title?: string
	participantActorIds?: string[]
}

export interface PostUserMessageOpts {
	mentions?: string[]
}

export interface ConversationRepository {
	list(workspaceId: string): Promise<Conversation[]>
	createConversation(workspaceId: string, draft: CreateConversationDraft): Promise<Conversation>
	updateConversation(
		workspaceId: string,
		conversationId: string,
		patch: { title?: string },
	): Promise<void>
	deleteConversation(workspaceId: string, conversationId: string): Promise<void>
	postUserMessage(
		workspaceId: string,
		conversationId: string,
		message: UserChatMessage,
		opts?: PostUserMessageOpts,
	): Promise<{ remoteId?: number }>
	addParticipant(workspaceId: string, conversationId: string, actorId: string): Promise<void>
	removeParticipant(workspaceId: string, conversationId: string, actorId: string): Promise<void>
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

function readLocal(workspaceId: string): Conversation[] {
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
}

function writeLocal(workspaceId: string, conversations: Conversation[]): void {
	if (typeof window === 'undefined') return
	try {
		window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(conversations))
	} catch (err) {
		console.error('[chat-store] failed to save conversations', err)
	}
}

/**
 * Helpers shared by both repositories — small mutators over the persisted
 * conversation array. Kept here so localStorageRepository can stay
 * declarative.
 */
function upsertConversation(
	conversations: Conversation[],
	conversation: Conversation,
): Conversation[] {
	const idx = conversations.findIndex((c) => c.id === conversation.id)
	if (idx === -1) return [conversation, ...conversations]
	const next = [...conversations]
	next[idx] = conversation
	return next
}

function patchConversationInList(
	conversations: Conversation[],
	id: string,
	patch: (c: Conversation) => Conversation,
): Conversation[] {
	return conversations.map((c) => (c.id === id ? { ...patch(c), updatedAt: Date.now() } : c))
}

/**
 * Client-only repository. Used as a fallback when there's no API key (e.g.
 * the marketing site) and as a deterministic implementation for tests.
 */
export const localStorageRepository: ConversationRepository = {
	async list(workspaceId) {
		return readLocal(workspaceId)
	},
	async createConversation(workspaceId, draft) {
		const conversation: Conversation = {
			...createConversation(),
			title:
				draft.title?.trim() && draft.title.trim().length > 0
					? draft.title.trim()
					: 'New conversation',
			participantIds: draft.participantActorIds ?? [],
		}
		writeLocal(workspaceId, upsertConversation(readLocal(workspaceId), conversation))
		return conversation
	},
	async updateConversation(workspaceId, conversationId, patch) {
		const next = patchConversationInList(readLocal(workspaceId), conversationId, (c) => ({
			...c,
			...(patch.title !== undefined ? { title: patch.title } : {}),
		}))
		writeLocal(workspaceId, next)
	},
	async deleteConversation(workspaceId, conversationId) {
		const next = readLocal(workspaceId).filter((c) => c.id !== conversationId)
		writeLocal(workspaceId, next)
	},
	async postUserMessage(workspaceId, conversationId, message) {
		const next = patchConversationInList(readLocal(workspaceId), conversationId, (c) => ({
			...c,
			messages: [...c.messages, message],
		}))
		writeLocal(workspaceId, next)
		return {}
	},
	async addParticipant(workspaceId, conversationId, actorId) {
		const next = patchConversationInList(readLocal(workspaceId), conversationId, (c) => ({
			...c,
			participantIds: [...new Set([...c.participantIds, actorId])],
		}))
		writeLocal(workspaceId, next)
	},
	async removeParticipant(workspaceId, conversationId, actorId) {
		const next = patchConversationInList(readLocal(workspaceId), conversationId, (c) => ({
			...c,
			participantIds: c.participantIds.filter((p) => p !== actorId),
		}))
		writeLocal(workspaceId, next)
	},
}

/**
 * API-backed repository — talks to T3's `/api/conversations` facade.
 *
 * The wire format only persists user-authored content + commented events on
 * the conversation object; agent message authorship (streamed events,
 * `streaming/complete/error/cancelled` status) is owned by the hook's in-
 * memory state and is not round-tripped through the API. When a conversation
 * loads from the server, each agent-authored `commented` event is folded into
 * a single complete-status `text` event so the transcript renders sensibly.
 *
 * `deleteConversation` is a no-op against the API because T3 doesn't expose
 * a DELETE route on `/api/conversations/:id` — the hook still removes the
 * row from local state so the UI behaves correctly within a session.
 */
export const apiConversationRepository: ConversationRepository = {
	async list(workspaceId) {
		const summaries = await api.conversations.list(workspaceId)
		const me = getStoredActor()
		// Load messages per conversation in parallel — the bet's panel never
		// renders more than a handful of recent conversations at once.
		const detailed = await Promise.all(
			summaries.map(async (summary) => {
				const [messages, participants] = await Promise.all([
					api.conversations.messages.list(workspaceId, summary.id, { limit: 200 }),
					api.conversations.participants.list(workspaceId, summary.id),
				])
				return hydrateConversation({
					summary,
					messages,
					participants,
					currentUserId: me?.id ?? null,
				})
			}),
		)
		return detailed.sort((a, b) => b.updatedAt - a.updatedAt)
	},
	async createConversation(workspaceId, draft) {
		const created = await api.conversations.create(workspaceId, {
			title: draft.title?.trim() && draft.title.trim().length > 0 ? draft.title.trim() : undefined,
			participant_actor_ids: draft.participantActorIds,
		})
		return {
			id: created.id,
			title:
				created.title?.trim() && created.title.trim().length > 0
					? created.title.trim()
					: 'New conversation',
			participantIds: draft.participantActorIds ?? [],
			messages: [],
			createdAt: parseIsoOrNow(created.createdAt),
			updatedAt: parseIsoOrNow(created.updatedAt ?? created.createdAt),
		}
	},
	async updateConversation() {
		// T3 doesn't expose PATCH /api/conversations/:id (object metadata edits
		// live on the generic /api/objects route). Titles are renamed in-memory
		// for now; a follow-up will route renames through PATCH /api/objects/:id.
	},
	async deleteConversation() {
		// T3 has no DELETE route. The hook still drops the row from local state.
	},
	async postUserMessage(workspaceId, conversationId, message, opts) {
		const created = await api.conversations.messages.create(workspaceId, conversationId, {
			content: message.text,
			...(opts?.mentions && opts.mentions.length > 0 ? { mentions: opts.mentions } : {}),
		})
		return { remoteId: created.id }
	},
	async addParticipant(workspaceId, conversationId, actorId) {
		await api.conversations.participants.add(workspaceId, conversationId, actorId)
	},
	async removeParticipant(workspaceId, conversationId, actorId) {
		await api.conversations.participants.remove(workspaceId, conversationId, actorId)
	},
}

function parseIsoOrNow(iso: string | null | undefined): number {
	if (!iso) return Date.now()
	const t = Date.parse(iso)
	return Number.isFinite(t) ? t : Date.now()
}

interface HydrateInput {
	summary: {
		id: string
		title: string | null
		createdAt: string | null
		updatedAt: string | null
	}
	messages: Array<{
		id: number
		actorId: string
		content: string
		createdAt: string | null
	}>
	participants: Array<{ actorId: string }>
	currentUserId: string | null
}

/**
 * Convert a server-shaped conversation (summary + commented events +
 * subscription rows) into the client-shaped `Conversation`. Commented events
 * from the current user become `UserChatMessage`; everything else is folded
 * into a `complete` agent message with a single `text` event so the
 * transcript renders without losing content.
 */
function hydrateConversation({
	summary,
	messages,
	participants,
	currentUserId,
}: HydrateInput): Conversation {
	const chatMessages: ChatMessage[] = messages.map((m) => {
		const createdAt = parseIsoOrNow(m.createdAt)
		if (currentUserId && m.actorId === currentUserId) {
			return {
				id: `evt_${m.id}`,
				role: 'user',
				senderId: m.actorId,
				senderName: 'You',
				text: m.content,
				createdAt,
				remoteId: m.id,
			} satisfies UserChatMessage
		}
		return {
			id: `evt_${m.id}`,
			role: 'agent',
			senderId: m.actorId,
			senderName: m.actorId,
			events: [{ kind: 'text', text: m.content }],
			status: 'complete',
			createdAt,
			remoteId: m.id,
		} satisfies AgentChatMessage
	})
	return {
		id: summary.id,
		title:
			summary.title?.trim() && summary.title.trim().length > 0
				? summary.title.trim()
				: 'New conversation',
		participantIds: participants
			.map((p) => p.actorId)
			.filter((id) => !currentUserId || id !== currentUserId),
		messages: chatMessages,
		createdAt: parseIsoOrNow(summary.createdAt),
		updatedAt: parseIsoOrNow(summary.updatedAt ?? summary.createdAt),
	}
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

/** Derives a human title from the first user message — mirrors v0/Claude. */
export function deriveConversationTitle(conversation: Conversation): string {
	const firstUser = conversation.messages.find((m) => m.role === 'user') as
		| UserChatMessage
		| undefined
	if (!firstUser) return conversation.title
	const text = firstUser.text.trim().replace(/\s+/g, ' ')
	if (text.length === 0) return conversation.title
	return text.length > 48 ? `${text.slice(0, 48)}…` : text
}
