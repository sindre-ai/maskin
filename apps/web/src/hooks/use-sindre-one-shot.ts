import { api } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { API_BASE } from '@/lib/constants'
import {
	type SindreSelectionAgent,
	type SindreSelectionNotification,
	type SindreSelectionObject,
	buildOneShotActionPrompt,
} from '@/lib/sindre-selection'
import { type SindreEvent, type UserAttachmentView, parseSindreLine } from '@/lib/sindre-stream'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { useCallback, useEffect, useRef, useState } from 'react'

export type SindreOneShotStatus = 'idle' | 'starting' | 'streaming' | 'closed' | 'error'

export interface SendOneShotArgs {
	workspaceId: string
	agent: SindreSelectionAgent
	content: string
	objects?: SindreSelectionObject[]
	notifications?: SindreSelectionNotification[]
	displayAttachments?: UserAttachmentView[]
}

export interface UseSindreOneShotResult {
	sessionId: string | null
	status: SindreOneShotStatus
	events: SindreEvent[]
	error: Error | null
	send: (args: SendOneShotArgs) => Promise<void>
	clear: () => void
}

/**
 * Fires a single-turn agent session. Used by `<SindreChat>` when the user has
 * selected an agent via the `/` picker — the message plus any attached object
 * context becomes the session's action_prompt, and stdout logs stream through
 * the sindre-stream parser so they render inline in the transcript alongside
 * regular Sindre events.
 */
export function useSindreOneShot(): UseSindreOneShotResult {
	const [sessionId, setSessionId] = useState<string | null>(null)
	const [status, setStatus] = useState<SindreOneShotStatus>('idle')
	const [events, setEvents] = useState<SindreEvent[]>([])
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
				action_prompt: buildOneShotActionPrompt(content, objects, notifications),
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

		const apiKey = getApiKey()
		const headers: Record<string, string> = { 'X-Workspace-Id': workspaceId }
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`

		await fetchEventSource(`${API_BASE}/sessions/${session.id}/logs/stream`, {
			signal: controller.signal,
			headers,
			openWhenHidden: true,
			async onopen() {},
			onmessage(msg) {
				if (msg.event === 'done') {
					setStatus('closed')
					return
				}
				if (msg.event === 'stdout') {
					const parsed = parseSindreLine(msg.data)
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
				const wrapped = err instanceof Error ? err : new Error(String(err))
				setStatus('error')
				setError(wrapped)
				throw wrapped
			},
		}).catch(() => {
			// onerror already captured into state; swallow the rejection.
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
