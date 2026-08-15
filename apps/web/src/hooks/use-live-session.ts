import { api } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { type ChatEvent, parseChatLine } from '@/lib/chat-stream'
import { API_BASE } from '@/lib/constants'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const IS_DEV = ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ??
	false) as boolean

export type LiveSessionStatus = 'idle' | 'loading' | 'connecting' | 'ready' | 'closed' | 'error'

export interface UseLiveSessionOptions {
	sessionId: string | null
	workspaceId: string
	enabled?: boolean
}

export interface UseLiveSessionResult {
	events: ChatEvent[]
	status: LiveSessionStatus
	error: Error | null
	sending: boolean
	send: (content: string) => Promise<void>
}

/**
 * Tails a pre-existing session's transcript: replays historic session_logs
 * once via GET /api/sessions/:id/logs, then subscribes to the live SSE stream
 * with `Last-Event-ID` set to the max replayed row id so the server skips
 * anything the replay already covered. `send()` posts the next user turn to
 * POST /api/sessions/:id/input.
 *
 * Distinct from useChatSession (chat-panel): that hook is keyed on
 * (workspaceId, agentActorId) and lazily bootstraps a container on first send
 * with localStorage-backed session id. Here the session id comes from the URL
 * so there's nothing to bootstrap or persist.
 */
export function useLiveSession({
	sessionId,
	workspaceId,
	enabled = true,
}: UseLiveSessionOptions): UseLiveSessionResult {
	const [events, setEvents] = useState<ChatEvent[]>([])
	const [status, setStatus] = useState<LiveSessionStatus>('idle')
	const [error, setError] = useState<Error | null>(null)
	const [sending, setSending] = useState(false)
	// Bumped once the historic /logs replay finishes for the current session
	// so the SSE effect can pass the correct `Last-Event-ID` (otherwise the
	// two effects race and SSE opens with id 0, replaying rows the client
	// already has).
	const [replayCursor, setReplayCursor] = useState<{ sessionId: string; maxId: number } | null>(
		null,
	)
	const sessionRef = useRef<string | null>(sessionId)

	useEffect(() => {
		if (sessionRef.current === sessionId) return
		sessionRef.current = sessionId
		setEvents([])
		setError(null)
		setStatus('idle')
		setReplayCursor(null)
	}, [sessionId])

	useEffect(() => {
		if (!enabled || !sessionId || !workspaceId) return
		let cancelled = false
		setStatus('loading')
		;(async () => {
			try {
				const logs = await api.sessions.logs(sessionId, workspaceId, { limit: '500' })
				if (cancelled) return
				const replayed: ChatEvent[] = []
				let maxId = 0
				for (const log of logs) {
					if (log.id > maxId) maxId = log.id
					if (log.stream === 'stdout') {
						for (const ev of parseChatLine(log.content, { includeUser: true })) {
							replayed.push(ev)
						}
					}
				}
				if (cancelled) return
				setEvents(replayed)
				setReplayCursor({ sessionId, maxId })
			} catch (err) {
				if (cancelled) return
				setStatus('error')
				setError(err instanceof Error ? err : new Error(String(err)))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [enabled, sessionId, workspaceId])

	useEffect(() => {
		if (!enabled || !sessionId || !workspaceId) return
		// Wait for the replay effect to publish its cursor for this session
		// before opening SSE, so `Last-Event-ID` reflects what we already have.
		if (!replayCursor || replayCursor.sessionId !== sessionId) return
		const controller = new AbortController()
		setStatus('connecting')
		let lastId = replayCursor.maxId

		const apiKey = getApiKey()
		const headers: Record<string, string> = { 'X-Workspace-Id': workspaceId }
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`
		if (lastId > 0) {
			headers['Last-Event-ID'] = String(lastId)
		}

		fetchEventSource(`${API_BASE}/sessions/${sessionId}/logs/stream`, {
			signal: controller.signal,
			headers,
			openWhenHidden: true,
			async onopen(response?: Response) {
				if (response && !response.ok) {
					const err = new Error(`SSE open failed: HTTP ${response.status}`)
					setStatus('error')
					setError(err)
					throw err
				}
				setStatus('ready')
			},
			onmessage(msg) {
				if (IS_DEV) {
					console.debug('[live-session] SSE envelope', { event: msg.event, data: msg.data })
				}
				if (msg.id) {
					const parsed = Number(msg.id)
					if (Number.isFinite(parsed) && parsed > lastId) {
						lastId = parsed
					}
				}
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
				setError(err instanceof Error ? err : new Error(String(err)))
			},
		}).catch((err) => {
			if (controller.signal.aborted) return
			console.error('[live-session] SSE connection failed', err)
			setError(err instanceof Error ? err : new Error(String(err)))
			setStatus('error')
		})

		return () => {
			controller.abort()
		}
	}, [enabled, sessionId, workspaceId, replayCursor])

	const send = useCallback(
		async (content: string) => {
			if (!sessionId) throw new Error('No conversation loaded')
			if (!workspaceId) throw new Error('No workspace selected')
			const trimmed = content.trim()
			if (trimmed.length === 0) return
			setSending(true)
			setError(null)
			setEvents((prev) => prev.concat({ kind: 'user', text: trimmed }))
			try {
				await api.sessions.input(sessionId, { content: trimmed }, workspaceId)
			} catch (err) {
				const wrapped = err instanceof Error ? err : new Error(String(err))
				setError(wrapped)
				throw wrapped
			} finally {
				setSending(false)
			}
		},
		[sessionId, workspaceId],
	)

	return useMemo(
		() => ({ events, status, error, sending, send }),
		[events, status, error, sending, send],
	)
}
