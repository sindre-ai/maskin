import { api } from '@/lib/api'
import type { SessionInputAttachment } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { API_BASE } from '@/lib/constants'
import { type SindreEvent, type UserAttachmentView, parseSindreLine } from '@/lib/sindre-stream'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_PREFIX = 'maskin-sindre-session'

// Bootstrap action_prompt is required by the create-session schema (min length 1)
// but is intentionally ignored at runtime for interactive sessions — the first
// real user turn arrives via POST /api/sessions/:id/input.
const BOOTSTRAP_ACTION_PROMPT = 'Sindre interactive chat'

function storageKey(workspaceId: string): string {
	return `${STORAGE_PREFIX}-${workspaceId}`
}

export function loadStoredSindreSessionId(workspaceId: string): string | null {
	if (!workspaceId) return null
	try {
		return localStorage.getItem(storageKey(workspaceId))
	} catch {
		return null
	}
}

function saveStoredSindreSessionId(workspaceId: string, sessionId: string): void {
	try {
		localStorage.setItem(storageKey(workspaceId), sessionId)
	} catch {}
}

export function clearStoredSindreSessionId(workspaceId: string): void {
	try {
		localStorage.removeItem(storageKey(workspaceId))
	} catch {}
}

export type SindreSessionStatus = 'idle' | 'starting' | 'connecting' | 'ready' | 'closed' | 'error'

export interface UseSindreSessionOptions {
	workspaceId: string
	sindreActorId: string | null
	enabled?: boolean
}

export interface UseSindreSessionResult {
	sessionId: string | null
	status: SindreSessionStatus
	events: SindreEvent[]
	error: Error | null
	send: (
		content: string,
		attachments?: SessionInputAttachment[],
		displayText?: string,
		displayAttachments?: UserAttachmentView[],
	) => Promise<void>
	reset: () => void
}

/**
 * Drives a single long-lived interactive Claude Code session for Sindre. On
 * first use it bootstraps a session for the given Sindre actor, persists the
 * session id in localStorage keyed by workspace, subscribes to the session's
 * stdout SSE log stream, and pipes each line through the sindre-stream parser
 * so consumers can render typed transcript events directly.
 */
export function useSindreSession({
	workspaceId,
	sindreActorId,
	enabled = true,
}: UseSindreSessionOptions): UseSindreSessionResult {
	const [sessionId, setSessionId] = useState<string | null>(() =>
		loadStoredSindreSessionId(workspaceId),
	)
	const [status, setStatus] = useState<SindreSessionStatus>('idle')
	const [events, setEvents] = useState<SindreEvent[]>([])
	const [error, setError] = useState<Error | null>(null)
	const startingRef = useRef(false)
	const prevWorkspaceIdRef = useRef(workspaceId)

	// Reset transcript + reload persisted sessionId when the workspace switches
	// (StrictMode-safe: only fires when workspaceId actually changes).
	useEffect(() => {
		if (prevWorkspaceIdRef.current === workspaceId) return
		prevWorkspaceIdRef.current = workspaceId
		startingRef.current = false
		setSessionId(loadStoredSindreSessionId(workspaceId))
		setEvents([])
		setError(null)
		setStatus('idle')
	}, [workspaceId])

	// Bootstrap an interactive session for Sindre when none is persisted.
	useEffect(() => {
		if (!enabled) return
		if (!workspaceId || !sindreActorId) return
		if (sessionId) return
		if (startingRef.current) return

		startingRef.current = true
		setStatus('starting')
		setError(null)

		api.sessions
			.create(workspaceId, {
				actor_id: sindreActorId,
				action_prompt: BOOTSTRAP_ACTION_PROMPT,
				config: { interactive: true },
				auto_start: true,
			})
			.then((session) => {
				saveStoredSindreSessionId(workspaceId, session.id)
				setSessionId(session.id)
			})
			.catch((err) => {
				setStatus('error')
				setError(err instanceof Error ? err : new Error(String(err)))
			})
			.finally(() => {
				startingRef.current = false
			})
	}, [enabled, workspaceId, sindreActorId, sessionId])

	// Subscribe to the session's live SSE log stream and pipe stdout through
	// the sindre-stream parser. stderr/system lines are surfaced as `debug`
	// events so the UI can collapse them without losing data.
	useEffect(() => {
		if (!enabled) return
		if (!workspaceId || !sessionId) return

		const controller = new AbortController()
		setStatus('connecting')

		const apiKey = getApiKey()
		const headers: Record<string, string> = { 'X-Workspace-Id': workspaceId }
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`

		fetchEventSource(`${API_BASE}/sessions/${sessionId}/logs/stream`, {
			signal: controller.signal,
			headers,
			openWhenHidden: true,
			async onopen() {
				setStatus('ready')
			},
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
				setStatus('error')
				setError(err instanceof Error ? err : new Error(String(err)))
				// Throw to stop fetch-event-source's default infinite retry.
				throw err
			},
		}).catch(() => {
			// onerror already captured into state; swallow the rejection.
		})

		return () => {
			controller.abort()
		}
	}, [enabled, workspaceId, sessionId])

	const send = useCallback(
		async (
			content: string,
			attachments?: SessionInputAttachment[],
			displayText?: string,
			displayAttachments?: UserAttachmentView[],
		) => {
			if (!sessionId) throw new Error('Sindre session is not ready yet')
			if (!workspaceId) throw new Error('No workspace selected')
			setEvents((prev) =>
				prev.concat({
					kind: 'user',
					text: displayText ?? content,
					...(displayAttachments && displayAttachments.length > 0
						? { attachments: displayAttachments }
						: {}),
				}),
			)
			const body = attachments && attachments.length > 0 ? { content, attachments } : { content }
			await api.sessions.input(sessionId, body, workspaceId)
		},
		[sessionId, workspaceId],
	)

	const reset = useCallback(() => {
		if (workspaceId) clearStoredSindreSessionId(workspaceId)
		startingRef.current = false
		setSessionId(null)
		setEvents([])
		setError(null)
		setStatus('idle')
	}, [workspaceId])

	return useMemo(
		() => ({ sessionId, status, events, error, send, reset }),
		[sessionId, status, events, error, send, reset],
	)
}
