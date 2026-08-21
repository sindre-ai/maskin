import { fetchEventSource } from '@microsoft/fetch-event-source'
import { getApiKey } from './auth'
import { API_BASE } from './constants'

export interface SSEEvent {
	id: string
	action: string
	workspace_id: string
	actor_id: string
	entity_type: string
	entity_id: string
	event_id: string
}

const LAST_EVENT_ID_KEY = 'maskin-last-event-id'

// Migrate old sessionStorage keys
try {
	const keys: string[] = []
	for (let i = 0; i < sessionStorage.length; i++) {
		const key = sessionStorage.key(i)
		if (key?.startsWith('ai-native-last-event-id-')) keys.push(key)
	}
	for (const key of keys) {
		const suffix = key.slice('ai-native-last-event-id-'.length)
		const newKey = `${LAST_EVENT_ID_KEY}-${suffix}`
		const val = sessionStorage.getItem(key)
		if (val && !sessionStorage.getItem(newKey)) {
			sessionStorage.setItem(newKey, val)
		}
		sessionStorage.removeItem(key)
	}
} catch {}

function getLastEventId(workspaceId: string): string | undefined {
	return sessionStorage.getItem(`${LAST_EVENT_ID_KEY}-${workspaceId}`) ?? undefined
}

function setLastEventId(workspaceId: string, id: string) {
	sessionStorage.setItem(`${LAST_EVENT_ID_KEY}-${workspaceId}`, id)
}

export type SSEStatus = 'connecting' | 'connected' | 'disconnected'

/**
 * How long the stream may stay completely silent before we assume the
 * connection is dead and force a reconnect.
 *
 * The server writes a `: ping` comment frame every 15s (SSE_HEARTBEAT_MS in
 * `apps/dev/src/routes/events.ts`), so silence beyond ~2.5 heartbeats means
 * bytes have stopped arriving. This matters because the failure mode we
 * actually see in production is *not* a clean error: when a proxy reaps an
 * idle connection half-open, the underlying fetch never rejects, so
 * `onerror` never fires and the client sits "connected" forever receiving
 * nothing. The user's only recovery was a page reload. This watchdog is what
 * turns that silent death into a normal reconnect.
 */
const SILENCE_TIMEOUT_MS = 40_000

export interface SSECallbacks {
	onEvent: (event: SSEEvent) => void
	onError?: (err: unknown) => void
	onStatusChange?: (status: SSEStatus) => void
	/**
	 * Fired when the stream re-opens after having been open before. Events
	 * that occurred during the gap are replayed from `Last-Event-ID`, but the
	 * server caps that replay at 100 events — so the caller should treat this
	 * as "your caches may have missed something" and resync.
	 */
	onReconnect?: () => void
}

export function connectSSE(workspaceId: string, callbacks: SSECallbacks): AbortController {
	// Outer controller: owned by the caller, aborts the whole subscription.
	const controller = new AbortController()
	const apiKey = getApiKey()

	// Inner controller: recreated per connection attempt so the watchdog can
	// tear down one dead connection without ending the subscription. The
	// outer abort cascades into whichever inner controller is current.
	let inner: AbortController | null = null
	let watchdog: ReturnType<typeof setTimeout> | null = null
	let stopped = false
	let hasConnectedBefore = false

	const clearWatchdog = () => {
		if (watchdog !== null) {
			clearTimeout(watchdog)
			watchdog = null
		}
	}

	const stop = () => {
		stopped = true
		clearWatchdog()
		inner?.abort()
	}
	controller.signal.addEventListener('abort', stop)

	/** Any byte from the server — event or heartbeat — resets the deadline. */
	const noteActivity = () => {
		if (stopped) return
		clearWatchdog()
		watchdog = setTimeout(() => {
			// Dead in the water. Abort this connection so the reconnect below
			// runs; without the abort the zombie fetch would hold the socket.
			callbacks.onStatusChange?.('disconnected')
			inner?.abort()
			connect()
		}, SILENCE_TIMEOUT_MS)
	}

	function connect() {
		if (stopped) return
		inner = new AbortController()
		callbacks.onStatusChange?.('connecting')

		// Read the cursor at each attempt, not once at subscribe time — after
		// a reconnect we want to resume from the newest event we've actually
		// seen, not from wherever we were when the page loaded.
		const lastEventId = getLastEventId(workspaceId)

		const pending = fetchEventSource(`${API_BASE}/events`, {
			signal: inner.signal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'X-Workspace-Id': workspaceId,
				...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
			},
			async onopen(response) {
				// Overriding `onopen` replaces fetch-event-source's own response
				// validation, so we have to do it ourselves. Without this a 502
				// HTML error page from the proxy — or a 401 — registers as a
				// healthy connection that simply never yields an event.
				if (response && !response.ok) {
					throw new Error(`SSE failed: ${response.status}`)
				}
				const contentType = response?.headers?.get?.('content-type')
				if (contentType && !contentType.includes('text/event-stream')) {
					throw new Error(`SSE bad content-type: ${contentType}`)
				}

				callbacks.onStatusChange?.('connected')
				noteActivity()
				if (hasConnectedBefore) callbacks.onReconnect?.()
				hasConnectedBefore = true
			},
			onmessage(msg) {
				// Reset the deadline before anything else: heartbeat comment
				// frames surface here with empty data, and they are precisely
				// the signal that the connection is still alive.
				noteActivity()

				if (!msg.data) return

				let parsed: SSEEvent
				try {
					parsed = JSON.parse(msg.data) as SSEEvent
				} catch {
					// Ignore malformed JSON from server
					return
				}

				parsed.id = msg.id
				parsed.action = msg.event || parsed.action

				if (msg.id) {
					setLastEventId(workspaceId, msg.id)
				}

				callbacks.onEvent(parsed)
			},
			onclose() {
				// The server ended the stream. Returning normally would make
				// fetch-event-source stop for good; throwing routes us through
				// `onerror`, which retries.
				throw new Error('SSE stream closed')
			},
			onerror(err) {
				if (stopped) throw err
				callbacks.onStatusChange?.('disconnected')
				callbacks.onError?.(err)
				// Returning (not throwing) tells fetch-event-source to retry.
				return RETRY_DELAY_MS
			},
			openWhenHidden: true,
		})

		// Terminal failure for this attempt (e.g. we threw from onopen).
		// Schedule our own retry so a bad gateway response doesn't end the
		// subscription permanently.
		pending?.catch?.(() => {
			if (stopped) return
			callbacks.onStatusChange?.('disconnected')
			clearWatchdog()
			setTimeout(() => connect(), RETRY_DELAY_MS)
		})
	}

	connect()

	return controller
}

/** Backoff between reconnect attempts. Deliberately short — chat feels broken while disconnected. */
const RETRY_DELAY_MS = 1_000
