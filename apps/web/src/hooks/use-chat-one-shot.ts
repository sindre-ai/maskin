import { trackChatSessionStarted } from '@/lib/analytics'
import { api } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import {
	type ChatSelectionAgent,
	type ChatSelectionFile,
	type ChatSelectionNotification,
	type ChatSelectionObject,
	buildOneShotActionPrompt,
} from '@/lib/chat-selection'
import { type ChatEvent, type UserAttachmentView, parseChatLine } from '@/lib/chat-stream'
import { API_BASE } from '@/lib/constants'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { useCallback, useEffect, useRef, useState } from 'react'

export type ChatOneShotStatus = 'idle' | 'starting' | 'streaming' | 'closed' | 'error'

export interface SendOneShotArgs {
	workspaceId: string
	agent: ChatSelectionAgent
	content: string
	objects?: ChatSelectionObject[]
	notifications?: ChatSelectionNotification[]
	files?: ChatSelectionFile[]
	displayAttachments?: UserAttachmentView[]
}

export interface UseChatOneShotResult {
	sessionId: string | null
	status: ChatOneShotStatus
	events: ChatEvent[]
	error: Error | null
	send: (args: SendOneShotArgs) => Promise<void>
	clear: () => void
}

/**
 * Fires a single-turn agent session. Used by `<Chat>` when the user has
 * selected an agent via the `/` picker — the message plus any attached object
 * context becomes the session's action_prompt, and stdout logs stream through
 * the chat-stream parser so they render inline in the transcript alongside
 * regular chat events.
 */
export function useChatOneShot(): UseChatOneShotResult {
	const [sessionId, setSessionId] = useState<string | null>(null)
	const [status, setStatus] = useState<ChatOneShotStatus>('idle')
	const [events, setEvents] = useState<ChatEvent[]>([])
	const [error, setError] = useState<Error | null>(null)
	const controllerRef = useRef<AbortController | null>(null)

	useEffect(() => {
		return () => {
			controllerRef.current?.abort()
			controllerRef.current = null
		}
	}, [])

	const send = useCallback(async (args: SendOneShotArgs) => {
		const {
			workspaceId,
			agent,
			content,
			objects = [],
			notifications = [],
			files = [],
			displayAttachments,
		} = args
		if (!workspaceId) throw new Error('No workspace selected')
		if (!agent?.id) throw new Error('No agent selected')

		controllerRef.current?.abort()
		const controller = new AbortController()
		controllerRef.current = controller

		setStatus('starting')
		setError(null)
		setEvents((prev) =>
			prev.concat({
				kind: 'user',
				text: content,
				...(displayAttachments && displayAttachments.length > 0
					? { attachments: displayAttachments }
					: {}),
			}),
		)

		let session: { id: string }
		try {
			session = await api.sessions.create(workspaceId, {
				actor_id: agent.id,
				action_prompt: buildOneShotActionPrompt(content, objects, notifications, files),
				auto_start: true,
			})
		} catch (err) {
			const wrapped = err instanceof Error ? err : new Error(String(err))
			setStatus('error')
			setError(wrapped)
			throw wrapped
		}

		setSessionId(session.id)
		setStatus('streaming')
		// Founder-substitution measurement: each one-shot is a fresh container
		// and a self-contained conversation start, so fire once per send.
		trackChatSessionStarted({
			entity_id: session.id,
			entity_type: 'session',
			entry_point: 'agent_one_shot',
		})

		const apiKey = getApiKey()
		const headers: Record<string, string> = { 'X-Workspace-Id': workspaceId }
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`

		// Fire-and-forget: the SSE stream stays open for the entire one-shot
		// turn (container exits when the agent finishes replying). Awaiting
		// it here would hold the composer's "sending" state hostage until
		// the agent is done, which is exactly what the user sees as a stale
		// spinner after the reply has already rendered. The hook's own
		// status / events / error are updated via the callbacks below.
		fetchEventSource(`${API_BASE}/sessions/${session.id}/logs/stream`, {
			signal: controller.signal,
			headers,
			openWhenHidden: true,
			async onopen(response?: Response) {
				// 4xx on open means the session is gone or auth expired — fatal,
				// stop retrying.
				if (response && !response.ok) {
					const err = new Error(`SSE open failed: HTTP ${response.status}`)
					setStatus('error')
					setError(err)
					throw err
				}
			},
			onmessage(msg) {
				if (msg.event === 'done') {
					setStatus('closed')
					return
				}
				if (msg.event === 'stdout') {
					const parsed = parseChatLine(msg.data)
					if (parsed.length === 0) return
					setEvents((prev) => prev.concat(parsed))
					return
				}
				if (msg.data) {
					const tag = msg.event ?? 'log'
					setEvents((prev) => prev.concat({ kind: 'debug', raw: `[${tag}] ${msg.data}` }))
				}
			},
			onerror(err) {
				// Transient network blips / server restarts land here.
				// fetch-event-source reconnects automatically when onerror
				// returns without throwing — flipping status to 'error' would
				// prematurely release the UI's pending spinner mid-retry, so
				// we only capture the error for diagnostics. Fatal 4xx is
				// handled in onopen (it throws to stop retries).
				setError(err instanceof Error ? err : new Error(String(err)))
			},
		}).catch((err) => {
			// onopen handles the fatal HTTP path. Anything else landing here
			// (abort-before-open, DNS, bug inside onmessage) must still be
			// logged or it disappears silently.
			if (controller.signal.aborted) return
			console.error('[chat-one-shot] SSE connection failed', err)
			setError(err instanceof Error ? err : new Error(String(err)))
			setStatus('error')
		})
	}, [])

	const clear = useCallback(() => {
		controllerRef.current?.abort()
		controllerRef.current = null
		setSessionId(null)
		setEvents([])
		setError(null)
		setStatus('idle')
	}, [])

	return { sessionId, status, events, error, send, clear }
}
