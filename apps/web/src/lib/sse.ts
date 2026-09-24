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

/**
 * A failure that retrying cannot fix — currently 401/403.
 *
 * Retrying these is worse than useless: the credentials are wrong and will
 * stay wrong, so the client would hammer the endpoint forever while showing
 * the user a generic "disconnected" chip that reads as a flaky network. The
 * subscription ends instead, and the error reaches `onError` so the caller
 * can say something actionable.
 */
export class SSEFatalError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = 'SSEFatalError'
	}
}

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

/** One raw SSE frame, before any consumer-specific decoding. */
export interface EventStreamFrame {
	/** `id:` field — the server's monotonic cursor for this stream. */
	id: string
	/** `event:` field — names the frame's kind (`stdout`, `done`, …). */
	event: string
	/** `data:` field — raw, undecoded. */
	data: string
}

/**
 * Consumer-specific knobs for {@link connectEventStream}.
 *
 * Everything here is supplied per consumer so one implementation can drive
 * both the workspace event stream and the session log stream. What stays
 * identical for every consumer — and is deliberately not configurable — is
 * the connection lifecycle: exponential reconnect backoff, the
 * silent-connection watchdog, resume-from-cursor, and rejection of an
 * HTML error page that arrives where a `text/event-stream` body belongs.
 */
export interface EventStreamOptions<T> {
	/** Called on every connect attempt, so a rotated token flows through. */
	urlBuilder: () => string
	/** Auth/identifying headers, re-read on every connect attempt. */
	headers: () => Record<string, string>
	/**
	 * Per-consumer resume cursor. Consumers that share a stream must not share
	 * a cursor — the log stream counts `sessionLogs.id`, the workspace stream
	 * counts workspace event ids, and folding them together would resume one
	 * from the other's position.
	 */
	cursor: { get: () => string | undefined; set: (id: string) => void }
	/** Turns a raw frame into the consumer's event type; `null` drops it. */
	decoder: (frame: EventStreamFrame) => T | null
	onEvent: (event: T) => void
	/**
	 * Fired when the server sends `event: done`, then the subscription stops
	 * *without* retrying. This is the graceful-stop signal: the workspace
	 * stream never emits `done`, but the log stream does when a session
	 * reaches a terminal state, and the default `onclose` behaviour (retry
	 * forever) would re-replay a finished session on a loop.
	 */
	onDone?: () => void
	onError?: (err: unknown) => void
	onStatusChange?: (status: SSEStatus) => void
	onReconnect?: () => void
}

/**
 * First reconnect delay. Deliberately short — chat feels broken while
 * disconnected, and the overwhelmingly common case is a single dropped
 * connection that comes straight back.
 */
const RETRY_BASE_MS = 1_000

/**
 * Ceiling for the exponential backoff. A flaky connection recovers at the
 * base delay; a backend that is genuinely down settles at one attempt every
 * 30s instead of one per second for the lifetime of the tab.
 */
const RETRY_MAX_MS = 30_000

/**
 * Subscribes to a server-sent event stream and keeps it open, reconnecting
 * with backoff until the caller aborts the returned controller.
 *
 * This is the generalised form of what used to be `connectSSE` — see
 * {@link connectSSE} for the workspace-event consumer, which is the original
 * behaviour expressed entirely in terms of this function.
 */
export function connectEventStream<T>(options: EventStreamOptions<T>): AbortController {
	// Outer controller: owned by the caller, aborts the whole subscription.
	const controller = new AbortController()

	// Inner controller: recreated per connection attempt so the watchdog can
	// tear down one dead connection without ending the subscription. The
	// outer abort cascades into whichever inner controller is current.
	let inner: AbortController | null = null
	let watchdog: ReturnType<typeof setTimeout> | null = null
	let stopped = false
	let hasConnectedBefore = false
	// Consecutive failed attempts, reset by a successful open. Drives the
	// backoff so a backend that is down (rather than flaky) isn't retried at
	// one request per second for as long as the tab stays open.
	let attempts = 0

	const nextRetryDelay = () => Math.min(RETRY_BASE_MS * 2 ** attempts++, RETRY_MAX_MS)

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
			options.onStatusChange?.('disconnected')
			inner?.abort()
			connect()
		}, SILENCE_TIMEOUT_MS)
	}

	function connect() {
		if (stopped) return
		inner = new AbortController()
		options.onStatusChange?.('connecting')

		// Read the cursor at each attempt, not once at subscribe time — after
		// a reconnect we want to resume from the newest event we've actually
		// seen, not from wherever we were when the page loaded.
		const lastEventId = options.cursor.get()

		const pending = fetchEventSource(options.urlBuilder(), {
			signal: inner.signal,
			headers: {
				...options.headers(),
				...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
			},
			async onopen(response) {
				// Overriding `onopen` replaces fetch-event-source's own response
				// validation, so we have to do it ourselves. Without this a 502
				// HTML error page from the proxy — or a 401 — registers as a
				// healthy connection that simply never yields an event.
				if (response && !response.ok) {
					if (response.status === 401 || response.status === 403) {
						throw new SSEFatalError(
							'Your session is no longer authorized — reload the page or sign in again.',
							response.status,
						)
					}
					throw new Error(`SSE failed: ${response.status}`)
				}
				const contentType = response?.headers?.get?.('content-type')
				if (contentType && !contentType.includes('text/event-stream')) {
					throw new Error(`SSE bad content-type: ${contentType}`)
				}

				attempts = 0
				options.onStatusChange?.('connected')
				noteActivity()
				if (hasConnectedBefore) options.onReconnect?.()
				hasConnectedBefore = true
			},
			onmessage(msg) {
				// Reset the deadline before anything else: heartbeat comment
				// frames surface here with empty data, and they are precisely
				// the signal that the connection is still alive.
				noteActivity()

				// The server's graceful-close signal. Stop without retrying —
				// see EventStreamOptions.onDone. `stopped` first so the watchdog
				// and the rejection handler below don't resurrect the stream.
				if (msg.event === 'done') {
					stopped = true
					clearWatchdog()
					options.onStatusChange?.('disconnected')
					options.onDone?.()
					inner?.abort()
					return
				}

				if (!msg.data) return

				const decoded = options.decoder({ id: msg.id, event: msg.event, data: msg.data })
				if (decoded === null) return

				if (msg.id) {
					options.cursor.set(msg.id)
				}

				options.onEvent(decoded)
			},
			onclose() {
				// A graceful stop returns so fetch-event-source settles quietly;
				// otherwise the server ended the stream unexpectedly. Returning
				// normally there would make fetch-event-source stop for good;
				// throwing routes us through `onerror`, which retries.
				if (stopped) return
				throw new Error('SSE stream closed')
			},
			onerror(err) {
				if (stopped) throw err
				options.onStatusChange?.('disconnected')
				options.onError?.(err)
				if (err instanceof SSEFatalError) {
					// Throwing ends the subscription for good. Set `stopped`
					// first so the watchdog and our own catch below don't
					// resurrect it.
					stopped = true
					clearWatchdog()
					throw err
				}
				// Returning (not throwing) tells fetch-event-source to retry.
				return nextRetryDelay()
			},
			openWhenHidden: true,
		})

		// Terminal failure for this attempt (e.g. we threw from onopen).
		// Schedule our own retry so a bad gateway response doesn't end the
		// subscription permanently.
		pending?.catch?.(() => {
			if (stopped) return
			options.onStatusChange?.('disconnected')
			clearWatchdog()
			setTimeout(() => connect(), nextRetryDelay())
		})
	}

	connect()

	return controller
}

/**
 * Subscribes to the workspace event stream (`GET /api/events`), the app's
 * invalidation bus. This is the original behaviour of `connectSSE`, now
 * expressed as a consumer of {@link connectEventStream}: JSON-decoded frames
 * carrying the workspace event envelope, resumed from the workspace cursor in
 * sessionStorage, retried on every close (this stream never voluntarily
 * closes).
 */
export function connectSSE(workspaceId: string, callbacks: SSECallbacks): AbortController {
	return connectEventStream<SSEEvent>({
		urlBuilder: () => `${API_BASE}/events`,
		// No Last-Event-ID here: the generic layer applies it from `cursor`
		// below, so a header set in both places would just be written twice.
		headers: () => ({
			Authorization: `Bearer ${getApiKey()}`,
			'X-Workspace-Id': workspaceId,
		}),
		cursor: {
			get: () => getLastEventId(workspaceId),
			set: (id) => setLastEventId(workspaceId, id),
		},
		decoder: (frame) => {
			let parsed: SSEEvent
			try {
				parsed = JSON.parse(frame.data) as SSEEvent
			} catch {
				// Ignore malformed JSON from server
				return null
			}
			parsed.id = frame.id
			parsed.action = frame.event || parsed.action
			return parsed
		},
		onEvent: callbacks.onEvent,
		onError: callbacks.onError,
		onStatusChange: callbacks.onStatusChange,
		onReconnect: callbacks.onReconnect,
	})
}
