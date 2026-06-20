import { useActors } from '@/hooks/use-actors'
import { api } from '@/lib/api'
import { getApiKey, getStoredActor } from '@/lib/auth'
import { parseMentionIds } from '@/lib/chat-mentions'
import { buildChatTurnPrompt } from '@/lib/chat-prompt'
import {
	type ChatMessage,
	type Conversation,
	type ConversationRepository,
	apiConversationRepository,
	createConversation,
	createId,
	deriveConversationTitle,
} from '@/lib/chat-store'
import { API_BASE } from '@/lib/constants'
import { trackChatMessageSent } from '@/lib/posthog'
import type {
	SindreSelectionFile,
	SindreSelectionNotification,
	SindreSelectionObject,
} from '@/lib/sindre-selection'
import { type SindreEvent, type UserAttachmentView, parseSindreLine } from '@/lib/sindre-stream'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const DEFAULT_AGENT_NAME = 'Sindre'

export interface ConversationParticipant {
	id: string
	name: string
	/** Whether this participant is an agent or a human. Determines whether
	 *  mentioning them spawns a session and which picker section they land in. */
	kind: 'human' | 'agent'
	/** Optional role label (e.g. "CTO", "Strategist") shown in the picker. */
	role?: string | null
	/** The always-present default agent (Sindre); cannot be removed. */
	isDefault: boolean
}

export interface ConversationSummary {
	id: string
	title: string
	updatedAt: number
	messageCount: number
}

export interface SendArgs {
	text: string
	objects?: SindreSelectionObject[]
	notifications?: SindreSelectionNotification[]
	files?: SindreSelectionFile[]
	displayAttachments?: UserAttachmentView[]
}

export interface UseSindreConversationArgs {
	workspaceId: string
	sindreActorId: string | null
	repository?: ConversationRepository
}

export interface UseSindreConversationResult {
	conversations: ConversationSummary[]
	activeId: string | null
	messages: ChatMessage[]
	participants: ConversationParticipant[]
	allAgents: ConversationParticipant[]
	/** Humans + agents in the workspace, used by the People & Agents picker. */
	allActors: ConversationParticipant[]
	workingAgentIds: string[]
	isBusy: boolean
	ready: boolean
	currentUserName: string
	send: (args: SendArgs) => void
	stop: (messageId?: string) => void
	regenerate: (messageId: string) => void
	newConversation: () => void
	selectConversation: (id: string) => void
	deleteConversation: (id: string) => void
	renameConversation: (id: string, title: string) => void
	addParticipant: (id: string) => void
	removeParticipant: (id: string) => void
}

/**
 * Orchestrates a standalone, multiplayer Sindre conversation: many agents +
 * the current human in one transcript, persisted through the
 * `ConversationRepository` (API-backed by default; pass `localStorageRepository`
 * to disable server-side persistence). Each agent reply is an independent
 * one-shot session streamed in parallel, so several agents can be "working…"
 * at once. Only `@mentioned` agents reply to a given message; if none are
 * mentioned the default agent (Sindre) answers.
 */
export function useSindreConversation({
	workspaceId,
	sindreActorId,
	repository = apiConversationRepository,
}: UseSindreConversationArgs): UseSindreConversationResult {
	const { data: actors } = useActors(workspaceId, { enabled: !!workspaceId })
	const [conversations, setConversations] = useState<Conversation[]>([])
	const [activeId, setActiveId] = useState<string | null>(null)
	const controllersRef = useRef<Map<string, AbortController>>(new Map())
	const hydratedRef = useRef<string | null>(null)

	const currentUser = useMemo(() => {
		const stored = getStoredActor()
		return { id: stored?.id ?? 'you', name: stored?.name?.trim() || 'You' }
	}, [])

	// Hydrate from the repository on mount / workspace switch. If hydration
	// returns no conversations, create one through the repository so it gets
	// persisted server-side and the composer has somewhere to write.
	useEffect(() => {
		if (!workspaceId || hydratedRef.current === workspaceId) return
		hydratedRef.current = workspaceId
		let cancelled = false
		;(async () => {
			let loaded: Conversation[] = []
			try {
				loaded = await repository.list(workspaceId)
			} catch (err) {
				console.error('[sindre-conversation] failed to load conversations', err)
			}
			if (cancelled) return
			if (loaded.length > 0) {
				setConversations(loaded)
				setActiveId(loaded[0].id)
				return
			}
			let fresh: Conversation
			try {
				fresh = await repository.createConversation(workspaceId, {})
			} catch (err) {
				console.error('[sindre-conversation] failed to create conversation', err)
				fresh = createConversation()
			}
			if (cancelled) return
			setConversations([fresh])
			setActiveId(fresh.id)
		})()
		return () => {
			cancelled = true
		}
	}, [workspaceId, repository])

	// Abort every in-flight stream on unmount.
	useEffect(() => {
		const controllers = controllersRef.current
		return () => {
			for (const controller of controllers.values()) controller.abort()
			controllers.clear()
		}
	}, [])

	const agentList = useMemo<ConversationParticipant[]>(() => {
		const fromActors = (actors ?? [])
			.filter((a) => a.type === 'agent')
			.map((a) => ({
				id: a.id,
				name: a.name,
				kind: 'agent' as const,
				role: a.description,
				isDefault: a.id === sindreActorId,
			}))
		// Guarantee the default agent is present even if the actors list hasn't
		// loaded yet or doesn't include it.
		if (sindreActorId && !fromActors.some((a) => a.id === sindreActorId)) {
			fromActors.unshift({
				id: sindreActorId,
				name: DEFAULT_AGENT_NAME,
				kind: 'agent' as const,
				role: null,
				isDefault: true,
			})
		}
		return fromActors
	}, [actors, sindreActorId])

	const humanList = useMemo<ConversationParticipant[]>(() => {
		return (actors ?? [])
			.filter((a) => a.type === 'human')
			.map((a) => ({
				id: a.id,
				name: a.name,
				kind: 'human' as const,
				role: a.role ?? null,
				isDefault: false,
			}))
	}, [actors])

	const allActors = useMemo<ConversationParticipant[]>(
		() => [...agentList, ...humanList],
		[agentList, humanList],
	)

	const defaultParticipant = useMemo<ConversationParticipant | null>(() => {
		if (!sindreActorId) return null
		const found = agentList.find((a) => a.id === sindreActorId)
		return found ?? { id: sindreActorId, name: DEFAULT_AGENT_NAME, kind: 'agent', isDefault: true }
	}, [agentList, sindreActorId])

	const active = useMemo(
		() => conversations.find((c) => c.id === activeId) ?? null,
		[conversations, activeId],
	)

	const participants = useMemo<ConversationParticipant[]>(() => {
		const out: ConversationParticipant[] = []
		if (defaultParticipant) out.push(defaultParticipant)
		for (const id of active?.participantIds ?? []) {
			if (id === sindreActorId) continue
			const resolved = allActors.find((a) => a.id === id)
			// Unknown IDs fall back to a human chip — agents always come from
			// `useActors`, so an unresolved id is almost always a workspace member
			// the actor list hasn't loaded yet, not a hidden bot.
			out.push(resolved ?? { id, name: shortId(id), kind: 'human', isDefault: false })
		}
		return out
	}, [defaultParticipant, active?.participantIds, allActors, sindreActorId])

	const workingAgentIds = useMemo(() => {
		const ids = new Set<string>()
		for (const m of active?.messages ?? []) {
			if (m.role === 'agent' && m.status === 'streaming') ids.add(m.senderId)
		}
		return Array.from(ids)
	}, [active?.messages])

	// ---- in-memory mutation helpers --------------------------------------
	// The repository owns server-side writes; these helpers keep React state in
	// sync for the streaming UI.

	const patchConversation = useCallback(
		(conversationId: string, updater: (c: Conversation) => Conversation) => {
			setConversations((prev) =>
				prev.map((c) => (c.id === conversationId ? updater({ ...c, updatedAt: Date.now() }) : c)),
			)
		},
		[],
	)

	const appendMessage = useCallback(
		(conversationId: string, message: ChatMessage) => {
			patchConversation(conversationId, (c) => {
				const next = { ...c, messages: [...c.messages, message] }
				if (c.title === 'New conversation') next.title = deriveConversationTitle(next)
				return next
			})
		},
		[patchConversation],
	)

	const patchMessage = useCallback(
		(conversationId: string, messageId: string, patch: Partial<ChatMessage>) => {
			patchConversation(conversationId, (c) => ({
				...c,
				messages: c.messages.map((m) =>
					m.id === messageId ? ({ ...m, ...patch } as ChatMessage) : m,
				),
			}))
		},
		[patchConversation],
	)

	const appendEvents = useCallback(
		(conversationId: string, messageId: string, events: SindreEvent[]) => {
			patchConversation(conversationId, (c) => ({
				...c,
				messages: c.messages.map((m) =>
					m.role === 'agent' && m.id === messageId ? { ...m, events: [...m.events, ...events] } : m,
				),
			}))
		},
		[patchConversation],
	)

	// ---- streaming a single agent turn -----------------------------------

	const runAgentTurn = useCallback(
		async (params: {
			conversationId: string
			messageId: string
			agent: ConversationParticipant
			prompt: string
		}) => {
			const { conversationId, messageId, agent, prompt } = params
			const controller = new AbortController()
			controllersRef.current.set(messageId, controller)

			let session: { id: string }
			try {
				session = await api.sessions.create(workspaceId, {
					actor_id: agent.id,
					action_prompt: prompt,
					auto_start: true,
					// Tell the session runtime which conversation this turn answers,
					// so the final reply is persisted as a `commented` event on the
					// conversation object once the session completes. Without this
					// the agent message only lives in the SSE log replay and has no
					// stable events.id for reactions / threading / reload hydration.
					config: { chat_reply: { conversation_id: conversationId } },
				})
			} catch (err) {
				controllersRef.current.delete(messageId)
				patchMessage(conversationId, messageId, {
					status: 'error',
					errorText: err instanceof Error ? err.message : 'Failed to reach agent',
				})
				return
			}

			const apiKey = getApiKey()
			const headers: Record<string, string> = { 'X-Workspace-Id': workspaceId }
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`

			fetchEventSource(`${API_BASE}/sessions/${session.id}/logs/stream`, {
				signal: controller.signal,
				headers,
				openWhenHidden: true,
				async onopen(response?: Response) {
					if (response && !response.ok) {
						throw new Error(`Stream failed: HTTP ${response.status}`)
					}
				},
				onmessage(msg) {
					if (msg.event === 'done') {
						controllersRef.current.delete(messageId)
						patchMessage(conversationId, messageId, { status: 'complete' })
						return
					}
					if (msg.event === 'stdout') {
						const parsed = parseSindreLine(msg.data).filter(isRenderableAgentEvent)
						if (parsed.length > 0) appendEvents(conversationId, messageId, parsed)
					}
				},
				onerror(err) {
					// Returning without throwing lets fetch-event-source retry
					// transient blips; we only record the error for diagnostics.
					console.error('[sindre-conversation] stream error', err)
				},
			}).catch((err) => {
				controllersRef.current.delete(messageId)
				if (controller.signal.aborted) return
				patchMessage(conversationId, messageId, {
					status: 'error',
					errorText: err instanceof Error ? err.message : 'Stream disconnected',
				})
			})
		},
		[workspaceId, appendEvents, patchMessage],
	)

	// ---- public actions ---------------------------------------------------

	const send = useCallback(
		(args: SendArgs) => {
			const text = args.text.trim()
			if (text.length === 0 || !active) return
			const conversationId = active.id

			// Resolve @mentions against the full agent roster so mentioning an
			// agent that isn't in the room yet also adds it as a participant.
			const mentionedIds = parseMentionIds(
				text,
				agentList.map((a) => ({ id: a.id, name: a.name })),
			)
			let targets: ConversationParticipant[] = agentList.filter((a) => mentionedIds.includes(a.id))
			if (targets.length === 0) {
				targets = defaultParticipant ? [defaultParticipant] : []
			}

			// Add any newly-mentioned agents to the room.
			const newParticipantIds = targets
				.filter((t) => !t.isDefault && !(active.participantIds ?? []).includes(t.id))
				.map((t) => t.id)

			const userMessage: ChatMessage = {
				id: createId('msg'),
				role: 'user',
				senderId: currentUser.id,
				senderName: currentUser.name,
				text,
				...(args.displayAttachments && args.displayAttachments.length > 0
					? { attachments: args.displayAttachments }
					: {}),
				createdAt: Date.now(),
			}

			const history = active.messages
			const participantNames = [
				currentUser.name,
				...participants.map((p) => p.name),
				...targets.filter((t) => !participants.some((p) => p.id === t.id)).map((t) => t.name),
			]

			// Commit user message + new participants to local state first so the
			// transcript renders without waiting on the round-trip.
			patchConversation(conversationId, (c) => {
				const next: Conversation = {
					...c,
					participantIds: [...new Set([...(c.participantIds ?? []), ...newParticipantIds])],
					messages: [...c.messages, userMessage],
				}
				if (c.title === 'New conversation') next.title = deriveConversationTitle(next)
				return next
			})

			// Ship metric — the bet's weekly-active surface lives on this event.
			// Fire on intent (pre-await) so a transient API failure doesn't drop
			// the metric. T4's surface-agnostic shape is preserved verbatim so
			// `chat_session_opened` + `chat_message_sent` share `surface`.
			trackChatMessageSent({
				workspace_id: workspaceId,
				surface: 'sheet',
				target_agent_id: targets.length === 1 && !targets[0].isDefault ? targets[0].id : null,
				attached_objects: args.objects?.length ?? 0,
				attached_notifications: args.notifications?.length ?? 0,
				attached_files: args.files?.length ?? 0,
			})

			// Persist server-side. Failures are logged but don't roll back the
			// optimistic UI commit — the user already sees their message.
			void repository
				.postUserMessage(workspaceId, conversationId, userMessage, {
					mentions: mentionedIds.length > 0 ? mentionedIds : undefined,
				})
				.then((res) => {
					if (res.remoteId === undefined) return
					patchMessage(conversationId, userMessage.id, { remoteId: res.remoteId })
				})
				.catch((err) => console.error('[sindre-conversation] postUserMessage failed', err))

			for (const actorId of newParticipantIds) {
				void repository.addParticipant(workspaceId, conversationId, actorId).catch((err) => {
					console.error('[sindre-conversation] addParticipant failed', err)
				})
			}

			// Spawn a streaming reply per target agent.
			for (const agent of targets) {
				const placeholder: ChatMessage = {
					id: createId('msg'),
					role: 'agent',
					senderId: agent.id,
					senderName: agent.name,
					events: [],
					status: 'streaming',
					createdAt: Date.now(),
				}
				appendMessage(conversationId, placeholder)
				const prompt = buildChatTurnPrompt({
					targetAgentName: agent.name,
					participantNames,
					history,
					userName: currentUser.name,
					userMessage: text,
					objects: args.objects,
					notifications: args.notifications,
					files: args.files,
				})
				void runAgentTurn({ conversationId, messageId: placeholder.id, agent, prompt })
			}
		},
		[
			active,
			agentList,
			defaultParticipant,
			participants,
			currentUser,
			workspaceId,
			repository,
			patchConversation,
			patchMessage,
			appendMessage,
			runAgentTurn,
		],
	)

	const stop = useCallback(
		(messageId?: string) => {
			if (!active) return
			const stopOne = (id: string) => {
				const controller = controllersRef.current.get(id)
				if (controller) {
					controller.abort()
					controllersRef.current.delete(id)
				}
				patchMessage(active.id, id, { status: 'cancelled' })
			}
			if (messageId) {
				stopOne(messageId)
				return
			}
			for (const m of active.messages) {
				if (m.role === 'agent' && m.status === 'streaming') stopOne(m.id)
			}
		},
		[active, patchMessage],
	)

	const regenerate = useCallback(
		(messageId: string) => {
			if (!active) return
			const index = active.messages.findIndex((m) => m.id === messageId)
			if (index < 0) return
			const target = active.messages[index]
			if (target.role !== 'agent') return
			const agent = agentList.find((a) => a.id === target.senderId) ?? {
				id: target.senderId,
				name: target.senderName,
				kind: 'agent' as const,
				isDefault: target.senderId === sindreActorId,
			}
			// Nearest preceding user message drives the regenerated turn.
			let userMessage: ChatMessage | null = null
			for (let i = index - 1; i >= 0; i--) {
				if (active.messages[i].role === 'user') {
					userMessage = active.messages[i]
					break
				}
			}
			if (!userMessage || userMessage.role !== 'user') return

			patchMessage(active.id, messageId, { events: [], status: 'streaming', errorText: undefined })
			const prompt = buildChatTurnPrompt({
				targetAgentName: agent.name,
				participantNames: [currentUser.name, ...participants.map((p) => p.name)],
				history: active.messages.slice(0, index).filter((m) => m.id !== messageId),
				userName: currentUser.name,
				userMessage: userMessage.text,
			})
			void runAgentTurn({ conversationId: active.id, messageId, agent, prompt })
		},
		[active, agentList, sindreActorId, currentUser, participants, patchMessage, runAgentTurn],
	)

	const newConversation = useCallback(() => {
		const empty = conversations.find((c) => c.messages.length === 0)
		if (empty) {
			setActiveId(empty.id)
			return
		}
		;(async () => {
			let fresh: Conversation
			try {
				fresh = await repository.createConversation(workspaceId, {})
			} catch (err) {
				console.error('[sindre-conversation] failed to create conversation', err)
				fresh = createConversation()
			}
			setConversations((prev) => [fresh, ...prev])
			setActiveId(fresh.id)
		})()
	}, [conversations, repository, workspaceId])

	const selectConversation = useCallback((id: string) => setActiveId(id), [])

	const deleteConversation = useCallback(
		(id: string) => {
			void repository.deleteConversation(workspaceId, id).catch((err) => {
				console.error('[sindre-conversation] deleteConversation failed', err)
			})
			setConversations((prev) => {
				const next = prev.filter((c) => c.id !== id)
				if (next.length === 0) {
					const fresh = createConversation()
					setActiveId(fresh.id)
					// The freshly-created placeholder isn't persisted until the user
					// sends a message — matches the previous behaviour where empty
					// conversations didn't write to localStorage.
					return [fresh]
				}
				if (id === activeId) setActiveId(next[0].id)
				return next
			})
		},
		[activeId, repository, workspaceId],
	)

	const renameConversation = useCallback(
		(id: string, title: string) => {
			const trimmed = title.trim()
			if (trimmed.length === 0) return
			patchConversation(id, (c) => ({ ...c, title: trimmed }))
			void repository.updateConversation(workspaceId, id, { title: trimmed }).catch((err) => {
				console.error('[sindre-conversation] updateConversation failed', err)
			})
		},
		[patchConversation, repository, workspaceId],
	)

	const addParticipant = useCallback(
		(id: string) => {
			if (!active || id === sindreActorId) return
			// Idempotency at the UI layer — `repository.addParticipant` is also
			// idempotent server-side via `onConflictDoNothing`, but skipping the
			// network round-trip here avoids needless work when the picker click
			// races a participant-bar refresh.
			if ((active.participantIds ?? []).includes(id)) return
			const conversationId = active.id
			patchConversation(conversationId, (c) => ({
				...c,
				participantIds: [...new Set([...(c.participantIds ?? []), id])],
			}))
			void repository.addParticipant(workspaceId, conversationId, id).catch((err) => {
				console.error('[sindre-conversation] addParticipant failed', err)
			})
		},
		[active, sindreActorId, patchConversation, repository, workspaceId],
	)

	const removeParticipant = useCallback(
		(id: string) => {
			if (!active) return
			const conversationId = active.id
			patchConversation(conversationId, (c) => ({
				...c,
				participantIds: (c.participantIds ?? []).filter((p) => p !== id),
			}))
			void repository.removeParticipant(workspaceId, conversationId, id).catch((err) => {
				console.error('[sindre-conversation] removeParticipant failed', err)
			})
		},
		[active, patchConversation, repository, workspaceId],
	)

	const summaries = useMemo<ConversationSummary[]>(
		() =>
			conversations
				.map((c) => ({
					id: c.id,
					title: c.title,
					updatedAt: c.updatedAt,
					messageCount: c.messages.length,
				}))
				.sort((a, b) => b.updatedAt - a.updatedAt),
		[conversations],
	)

	return {
		conversations: summaries,
		activeId,
		messages: active?.messages ?? [],
		participants,
		allAgents: agentList,
		allActors,
		workingAgentIds,
		isBusy: workingAgentIds.length > 0,
		ready: !!workspaceId,
		currentUserName: currentUser.name,
		send,
		stop,
		regenerate,
		newConversation,
		selectConversation,
		deleteConversation,
		renameConversation,
		addParticipant,
		removeParticipant,
	}
}

function isRenderableAgentEvent(event: SindreEvent): boolean {
	return event.kind === 'text' || event.kind === 'thinking' || event.kind === 'tool_use'
}

function shortId(id: string): string {
	return id.length > 8 ? `${id.slice(0, 8)}…` : id
}
