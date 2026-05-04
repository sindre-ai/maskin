import { api } from '@/lib/api'
import type { SessionInputAttachment } from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { API_BASE } from '@/lib/constants'
import { type SindreEvent, type UserAttachmentView, parseSindreLine } from '@/lib/sindre-stream'
import { fetchEventSource } from '@microsoft/fetch-event-source'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Vite replaces `import.meta.env.DEV` at build time. Reading it through a
// cast keeps us out of the vite/client ambient type dependency while still
// compiling to the same boolean.
const IS_DEV = ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ??
	false) as boolean

// Bootstrap action_prompt is required by the create-session schema (min length 1)
// but is intentionally ignored at runtime for interactive sessions — the first
// real user turn arrives via POST /api/sessions/:id/input.
const BOOTSTRAP_ACTION_PROMPT = 'Sindre interactive chat'

const RUNNING_POLL_INTERVAL_MS = 300
const RUNNING_POLL_TIMEOUT_MS = 20_000
const TERMINAL_SESSION_STATUSES = new Set(['failed', 'timeout', 'completed', 'paused'])

/**
 * Poll `GET /api/sessions/:id` until the session's container transitions to
 * `running`. The create endpoint returns as soon as the DB row is written
 * (status `pending`), so a plain POST /input straight after create hits a 409
 * — this gives the backend a chance to pull agent files + launch the
 * container before we hand it the user's first turn.
 */
async function waitForRunning(sessionId: string, workspaceId: string): Promise<void> {
	const deadline = Date.now() + RUNNING_POLL_TIMEOUT_MS
	while (Date.now() < deadline) {
		const session = await api.sessions.get(sessionId, workspaceId)
		if (session.status === 'running') return
		if (TERMINAL_SESSION_STATUSES.has(session.status)) {
			throw new Error(`Session ${session.status} before it could start`)
		}
		await new Promise((resolve) => setTimeout(resolve, RUNNING_POLL_INTERVAL_MS))
	}
	throw new Error('Sindre session did not start in time')
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
 * first send it bootstraps a session for the given Sindre actor, subscribes
 * to the session's stdout SSE log stream, and pipes each line through the
 * sindre-stream parser so consumers can render typed transcript events
 * directly. Session id is tab-local — a reload starts a fresh session on the
 * next send.
 */
export function useSindreSession({
	workspaceId,
	sindreActorId,
	enabled = true,
}: UseSindreSessionOptions): UseSindreSessionResult {
	const [sessionId, setSessionId] = useState<string | null>(null)
	const [status, setStatus] = useState<SindreSessionStatus>('idle')
	const [events, setEvents] = useState<SindreEvent[]>([])
	const [error, setError] = useState<Error | null>(null)
	const startingRef = useRef(false)
	const prevWorkspaceIdRef = useRef(workspaceId)
	// Monotonic counter bumped whenever the session is discarded (reset() or
	// workspace switch). An in-flight send() captures the counter before
	// bootstrap and bails out if it changed — otherwise a fast reset between
	// `api.sessions.create` resolving and `waitForRunning` finishing would
	// re-mount an SSE stream on a session the user thought they discarded.
	const generationRef = useRef(0)

	// Reset transcript + reload persisted sessionId when the workspace switches
	// (StrictMode-safe: only fires when workspaceId actually changes).
	useEffect(() => {
		if (prevWorkspaceIdRef.current === workspaceId) return
		prevWorkspaceIdRef.current = workspaceId
		generationRef.current += 1
		startingRef.current = false
		setSessionId(null)
		setEvents([])
		setError(null)
		setStatus('idle')
	}, [workspaceId])

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
			async onopen(response?: Response) {
				// 4xx on open means the session is gone or auth expired — fatal,
				// stop retrying. Non-2xx passed to onerror would otherwise retry
				// forever.
				if (response && !response.ok) {
					const err = new Error(`SSE open failed: HTTP ${response.status}`)
					setStatus('error')
					setError(err)
					throw err
				}
				setStatus('ready')
			},
			onmessage(msg) {
				// Dev-only firehose: dump every SSE envelope so the raw CLI
				// stream is inspectable in DevTools when diagnosing rendering
				// mismatches. Gated on IS_DEV so production builds
				// stay quiet.
				if (IS_DEV) {
					console.debug('[sindre-session] SSE envelope', {
						event: msg.event,
						data: msg.data,
					})
				}
				if (msg.event === 'done') {
					setStatus('closed')
					return
				}
				if (msg.event === 'stdout') {
					const parsed = parseSindreLine(msg.data)
					if (parsed.length === 0) return
					if (IS_DEV) {
						console.debug('[sindre-session] parsed events', parsed)
					}
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
				// prematurely release the chat surface's pending spinner
				// mid-retry, so we only capture the error for diagnostics.
				// Fatal errors (4xx) come through onopen above which throws
				// to stop retries.
				setError(err instanceof Error ? err : new Error(String(err)))
			},
		}).catch((err) => {
			// onopen already sets error state for the fatal HTTP path it throws
			// from. Anything else that lands here (abort-before-open, DNS, bug
			// inside onmessage) must still be logged or it vanishes silently.
			if (controller.signal.aborted) return
			console.error('[sindre-session] SSE connection failed', err)
			setError(err instanceof Error ? err : new Error(String(err)))
			setStatus('error')
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
			if (!workspaceId) throw new Error('No workspace selected')
			if (!sindreActorId) throw new Error('Sindre agent not available')

			// Lazy bootstrap — only create the container on the user's first
			// turn, so opening the panel (or re-mounting the app) never spawns
			// a session.
			let currentSessionId = sessionId
			const generation = generationRef.current
			if (!currentSessionId) {
				if (startingRef.current) throw new Error('Sindre session is still starting')
				startingRef.current = true
				setStatus('starting')
				setError(null)
				try {
					const session = await api.sessions.create(workspaceId, {
						actor_id: sindreActorId,
						action_prompt: BOOTSTRAP_ACTION_PROMPT,
						config: { interactive: true },
						auto_start: true,
					})
					// If reset() fired between create() resolving and now, the
					// user discarded this session — don't mount an SSE stream
					// on it.
					if (generationRef.current !== generation) {
						throw new Error('Sindre session was reset during bootstrap')
					}
					currentSessionId = session.id
					setSessionId(session.id)
					// Wait for the container to actually be running before we
					// POST the user's turn — otherwise the input endpoint
					// rejects with 409 "Session is not running".
					await waitForRunning(currentSessionId, workspaceId)
					if (generationRef.current !== generation) {
						throw new Error('Sindre session was reset during bootstrap')
					}
				} catch (err) {
					if (generationRef.current === generation) {
						setStatus('error')
						const wrapped = err instanceof Error ? err : new Error(String(err))
						setError(wrapped)
						throw wrapped
					}
					// Reset happened — don't clobber the post-reset 'idle' state
					// with 'error'. Still surface the cancellation to the caller.
					throw err instanceof Error ? err : new Error(String(err))
				} finally {
					startingRef.current = false
				}
			}

			if (generationRef.current !== generation) {
				throw new Error('Sindre session was reset during bootstrap')
			}

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
			await api.sessions.input(currentSessionId, body, workspaceId)
		},
		[sessionId, workspaceId, sindreActorId],
	)

	const reset = useCallback(() => {
		generationRef.current += 1
		startingRef.current = false
		setSessionId(null)
		setEvents([])
		setError(null)
		setStatus('idle')
	}, [])

	return useMemo(
		() => ({ sessionId, status, events, error, send, reset }),
		[sessionId, status, events, error, send, reset],
	)
}
