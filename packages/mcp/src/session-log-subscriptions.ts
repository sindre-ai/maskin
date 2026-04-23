import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type ManagedSSEStream, type ParsedSSEFrame, createManagedSSE } from './lib/managed-sse.js'

interface McpConfig {
	apiBaseUrl: string
	apiKey: string
	defaultWorkspaceId: string
}

export interface SessionLogSubscription {
	id: string
	sessionId: string
	workspaceId: string
	createdAt: string
	logsDelivered: number
	logsDropped: number
}

export interface SessionLogSubscriptionRegistry {
	add(workspaceId: string, sessionId: string): SessionLogSubscription
	remove(id: string): boolean
	list(): SessionLogSubscription[]
	shutdownAll(): Promise<void>
}

// A single parsed log line from /api/sessions/:id/logs/stream.
// The backend emits `event: stdout|stderr|system` with `data` set to the raw
// text content (no JSON wrapping). A synthetic kind='done' is produced when
// the server sends `event: done, data: <session status>` — the status is
// whatever terminal state the session reached (completed | failed | timeout).
type SessionLogItem =
	| { kind: 'log'; stream: 'stdout' | 'stderr' | 'system'; content: string }
	| { kind: 'done'; status: string }

function parseLogFrame(
	frame: ParsedSSEFrame,
): { item?: SessionLogItem; terminal?: boolean } | null {
	if (frame.event === 'done') {
		return { item: { kind: 'done', status: frame.data ?? 'unknown' }, terminal: true }
	}
	if (frame.data === undefined) return null
	const stream = frame.event
	if (stream !== 'stdout' && stream !== 'stderr' && stream !== 'system') return null
	return { item: { kind: 'log', stream, content: frame.data } }
}

export function createSessionLogSubscriptionRegistry(
	config: McpConfig,
	mcpServer: McpServer,
): SessionLogSubscriptionRegistry {
	// One ManagedSSEStream per sessionId — log streams are a firehose, so all
	// subscribers to the same session share a single connection.
	const streams = new Map<string, ManagedSSEStream>()
	const subs = new Map<string, SessionLogSubscription>()
	const subToSession = new Map<string, string>()

	function streamForSession(workspaceId: string, sessionId: string): ManagedSSEStream {
		let stream = streams.get(sessionId)
		if (stream) return stream
		// Set to true once a `done` frame is fully delivered to every subscriber
		// (no firstDeliveryError). If the stream terminates and this is still
		// false, onTerminal sends a fallback `terminated` notification so the
		// client never sees a silent teardown.
		let terminalDelivered = false
		stream = createManagedSSE<SessionLogItem>({
			url: `${config.apiBaseUrl}/api/sessions/${sessionId}/logs/stream`,
			headers: () => ({
				Authorization: `Bearer ${config.apiKey}`,
				'X-Workspace-Id': workspaceId,
				Accept: 'text/event-stream',
			}),
			parseFrame: parseLogFrame,
			onItem: async (item) => {
				const isError = item.kind === 'log' && item.stream === 'stderr'
				const level = isError ? 'error' : 'info'
				const data =
					item.kind === 'done'
						? { kind: 'done' as const, session_id: sessionId, status: item.status }
						: {
								kind: 'log' as const,
								session_id: sessionId,
								stream: item.stream,
								content: item.content,
							}
				let firstDeliveryError: unknown = null
				for (const [subId, sessId] of subToSession) {
					if (sessId !== sessionId) continue
					const sub = subs.get(subId)
					if (!sub) continue
					try {
						await mcpServer.server.sendLoggingMessage({
							level,
							logger: 'maskin/session-logs',
							data: { subscription_id: sub.id, ...data },
						})
						sub.logsDelivered++
					} catch (err) {
						sub.logsDropped++
						if (firstDeliveryError === null) firstDeliveryError = err
						console.error(
							`[maskin-mcp] Session-log delivery failed for ${subId}:`,
							err instanceof Error ? err.message : err,
						)
					}
				}
				// Re-throw on delivery error so managed-sse holds lastEventId / dedup
				// state — a reconnect will retry. Terminal frames still propagate
				// to onTerminal via handleFrame's `terminal` return value.
				if (firstDeliveryError !== null) throw firstDeliveryError
				if (item.kind === 'done') terminalDelivered = true
			},
			onWarn: async (level, message) => {
				try {
					await mcpServer.server.sendLoggingMessage({
						level,
						logger: 'maskin/session-logs',
						data: { session_id: sessionId, message },
					})
				} catch (err) {
					console.error(
						'[maskin-mcp] Session-log warning delivery failed:',
						err instanceof Error ? err.message : err,
					)
				}
			},
			onTerminal: (reason) => {
				const orphaned = [...subToSession.entries()].filter(([, s]) => s === sessionId)
				// Best-effort fallback: if no `done` frame was fully delivered, the
				// client would otherwise see a silent teardown (auth error, transport
				// drop, or delivery failure on the `done` frame itself). Send a
				// `terminated` notification so every subscriber learns the stream
				// closed.
				if (!terminalDelivered) {
					for (const [subId] of orphaned) {
						const sub = subs.get(subId)
						if (!sub) continue
						mcpServer.server
							.sendLoggingMessage({
								level: reason === 'auth_error' ? 'error' : 'info',
								logger: 'maskin/session-logs',
								data: {
									subscription_id: sub.id,
									kind: 'terminated' as const,
									session_id: sessionId,
									reason,
								},
							})
							.catch((err) => {
								console.error(
									'[maskin-mcp] Session-log terminal notification failed:',
									err instanceof Error ? err.message : err,
								)
							})
					}
				}
				streams.delete(sessionId)
				for (const [subId] of orphaned) {
					subs.delete(subId)
					subToSession.delete(subId)
				}
			},
			// Matches the backend replay cap in apps/dev/src/routes/sessions.ts.
			replayCap: 500,
			logTag: `session ${sessionId}`,
		})
		streams.set(sessionId, stream)
		return stream
	}

	return {
		add(workspaceId, sessionId) {
			const sub: SessionLogSubscription = {
				id: randomUUID(),
				sessionId,
				workspaceId,
				createdAt: new Date().toISOString(),
				logsDelivered: 0,
				logsDropped: 0,
			}
			subs.set(sub.id, sub)
			subToSession.set(sub.id, sessionId)
			streamForSession(workspaceId, sessionId).addRef(sub.id)
			return sub
		},
		remove(id) {
			const sessionId = subToSession.get(id)
			if (!sessionId) return false
			const stream = streams.get(sessionId)
			if (!stream) {
				subs.delete(id)
				subToSession.delete(id)
				return false
			}
			const existed = stream.removeRef(id)
			subs.delete(id)
			subToSession.delete(id)
			if (!stream.hasRefs()) {
				void stream.stop()
				streams.delete(sessionId)
			}
			return existed
		},
		list() {
			return [...subs.values()]
		},
		async shutdownAll() {
			const toStop = [...streams.values()]
			streams.clear()
			subs.clear()
			subToSession.clear()
			await Promise.all(toStop.map((s) => s.stop()))
		},
	}
}
