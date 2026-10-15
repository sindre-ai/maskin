import type { SessionLogResponse } from './api'
import { getApiKey } from './auth'
import { API_BASE } from './constants'
import { connectEventStream } from './sse'

/**
 * Per-session resume cursor for the log stream.
 *
 * Deliberately a separate key space from the workspace-event cursor in
 * `sse.ts`. The two streams number their frames from different sequences —
 * the workspace stream counts workspace event ids, this one counts
 * `session_logs.id` — so sharing a cursor would resume one stream from a
 * position that means nothing to the other.
 */
const CURSOR_KEY = 'maskin-last-session-log-id'

function getCursor(sessionId: string): string | undefined {
	return sessionStorage.getItem(`${CURSOR_KEY}-${sessionId}`) ?? undefined
}

function setCursor(sessionId: string, id: string) {
	sessionStorage.setItem(`${CURSOR_KEY}-${sessionId}`, id)
}

export type SessionLogListener = (log: SessionLogResponse) => void

/**
 * Fired once, when the server ends this session's stream with `done` — the
 * session reached a terminal state. Distinct from the unsubscribe function
 * returned by {@link subscribeToSessionLogs}: this is the *server* ending the
 * stream, not the consumer leaving.
 */
export type SessionDoneListener = () => void

interface Connection {
	controller: AbortController
	listeners: Set<SessionLogListener>
	doneListeners: Set<SessionDoneListener>
}

/**
 * One live connection per session id, shared by every subscriber.
 *
 * Module-scoped rather than per-hook because the browser allows a limited
 * number of concurrent connections per origin (6 on HTTP/1.1, which is what
 * the Vite dev server speaks). Two components watching the same session — a
 * transcript and an activity dropdown, say — must not each open their own
 * stream; they share one and fan out.
 */
const connections = new Map<string, Connection>()

/**
 * Subscribe to a session's log stream (`GET /api/sessions/:id/logs/stream`).
 *
 * The first subscriber for a session id opens the connection; the rest attach
 * to it. The returned function detaches this listener and aborts the
 * connection once the last one leaves, so unmount / route-change / tab-close
 * cannot leak a socket.
 *
 * Frames arrive as `{ id, event, data }` where `event` is the log stream
 * (`stdout` | `stderr` | `system`) and `data` is the raw line; the `done`
 * frame that marks a terminal session is swallowed here (see the decoder) and
 * surfaced to `onDone` instead.
 */
export function subscribeToSessionLogs(
	workspaceId: string,
	sessionId: string,
	onLog: SessionLogListener,
	onDone?: SessionDoneListener,
): () => void {
	let connection = connections.get(sessionId)

	if (!connection) {
		const listeners = new Set<SessionLogListener>()
		const doneListeners = new Set<SessionDoneListener>()
		const controller = connectEventStream<SessionLogResponse>({
			urlBuilder: () => `${API_BASE}/sessions/${sessionId}/logs/stream`,
			headers: () => ({
				Authorization: `Bearer ${getApiKey()}`,
				'X-Workspace-Id': workspaceId,
			}),
			cursor: {
				get: () => getCursor(sessionId),
				set: (id) => setCursor(sessionId, id),
			},
			decoder: (frame) => {
				// `done` names a terminal session, not a log line. Returning
				// null drops it without advancing the cursor, so a reconnect
				// after a terminal state replays from the last real line.
				if (frame.event === 'done') return null
				const id = Number(frame.id)
				if (!Number.isFinite(id)) return null
				return {
					id,
					sessionId,
					stream: frame.event,
					content: frame.data,
					createdAt: null,
				}
			},
			onEvent: (log) => {
				for (const listener of listeners) listener(log)
			},
			onDone: () => {
				// The core has already stopped this connection without
				// retrying. Fan out to every subscriber that asked to hear
				// about completion, then drop the registry entry so a later
				// subscribe for the same session starts a fresh one rather
				// than attaching to a dead controller. What each subscriber
				// does at end-of-session — the chat hook's single grace tick —
				// is the caller's business, not this module's.
				for (const listener of doneListeners) listener()
				connections.delete(sessionId)
			},
		})
		connection = { controller, listeners, doneListeners }
		connections.set(sessionId, connection)
	}

	const owned = connection
	owned.listeners.add(onLog)
	if (onDone) owned.doneListeners.add(onDone)

	return () => {
		// A `done` may have replaced the registry entry since we subscribed;
		// only the connection we actually hold may be torn down.
		if (connections.get(sessionId) !== owned) return
		owned.listeners.delete(onLog)
		if (onDone) owned.doneListeners.delete(onDone)
		if (owned.listeners.size === 0) {
			owned.controller.abort()
			connections.delete(sessionId)
		}
	}
}

/** Live connection count. Exported for tests asserting no leaked sockets. */
export function activeSessionLogConnections(): number {
	return connections.size
}
