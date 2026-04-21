import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

interface McpConfig {
	apiBaseUrl: string
	apiKey: string
	defaultWorkspaceId: string
}

export interface EventFilter {
	entity_type?: string[]
	entity_id?: string[]
	action?: string[]
	actor_id?: string[]
}

export interface MaskinEvent {
	workspace_id: string
	actor_id: string
	action: string
	entity_type: string
	entity_id: string
	event_id: string
}

export interface Subscription {
	id: string
	workspaceId: string
	filter: EventFilter
	createdAt: string
	eventsDelivered: number
	eventsDropped: number
}

export interface SubscriptionRegistry {
	add(workspaceId: string, filter: EventFilter): Subscription
	remove(id: string): boolean
	list(): Subscription[]
	shutdownAll(): Promise<void>
}

export function matchesFilter(event: MaskinEvent, filter: EventFilter): boolean {
	if (filter.entity_type?.length && !filter.entity_type.includes(event.entity_type)) return false
	if (filter.entity_id?.length && !filter.entity_id.includes(event.entity_id)) return false
	if (filter.action?.length && !filter.action.includes(event.action)) return false
	if (filter.actor_id?.length && !filter.actor_id.includes(event.actor_id)) return false
	return true
}

// Live NOTIFY frames use snake_case; DB-row replays use camelCase. Normalize to snake_case
// and omit the deprecated `data` field so subscribers see one consistent shape.
function normalizeEvent(raw: Record<string, unknown>): MaskinEvent {
	return {
		workspace_id: String(raw.workspace_id ?? raw.workspaceId ?? ''),
		actor_id: String(raw.actor_id ?? raw.actorId ?? ''),
		action: String(raw.action ?? ''),
		entity_type: String(raw.entity_type ?? raw.entityType ?? ''),
		entity_id: String(raw.entity_id ?? raw.entityId ?? ''),
		event_id: String(raw.event_id ?? raw.id ?? ''),
	}
}

export interface ParsedSSEFrame {
	id?: string
	event?: string
	data?: string
}

// Split a buffer of SSE text into complete frames plus a residual partial frame.
// Frames are `\n\n`-delimited; `\r\n` line endings are normalized to `\n`.
// Within a frame, each line is `field: value` — `data` lines are concatenated with `\n`,
// and lines starting with `:` are comments.
export function parseSSEChunk(buffer: string): { frames: ParsedSSEFrame[]; residual: string } {
	const frames: ParsedSSEFrame[] = []
	const normalized = buffer.replace(/\r\n/g, '\n')
	const parts = normalized.split('\n\n')
	const residual = parts.pop() ?? ''
	for (const part of parts) {
		if (!part) continue
		const frame: ParsedSSEFrame = {}
		const dataLines: string[] = []
		let hasField = false
		for (const line of part.split('\n')) {
			if (!line || line.startsWith(':')) continue
			const colon = line.indexOf(':')
			if (colon === -1) continue
			const field = line.slice(0, colon)
			let value = line.slice(colon + 1)
			if (value.startsWith(' ')) value = value.slice(1)
			if (field === 'id') {
				frame.id = value
				hasField = true
			} else if (field === 'event') {
				frame.event = value
				hasField = true
			} else if (field === 'data') {
				dataLines.push(value)
				hasField = true
			}
		}
		if (dataLines.length) frame.data = dataLines.join('\n')
		if (hasField) frames.push(frame)
	}
	return { frames, residual }
}

type DeliverFn = (sub: Subscription, event: MaskinEvent) => Promise<void>
type WarnFn = (workspaceId: string, level: 'warning' | 'error', message: string) => Promise<void>

class WorkspaceStream {
	private readonly subs = new Map<string, Subscription>()
	private readonly filters = new Map<string, EventFilter>()
	private abortController: AbortController | null = null
	private lastEventId: string | null = null
	private stopped = false
	private reconnectAttempts = 0
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private readonly recentEventIds: string[] = []
	private runPromise: Promise<void> | null = null

	constructor(
		private readonly workspaceId: string,
		private readonly config: McpConfig,
		private readonly deliver: DeliverFn,
		private readonly warn: WarnFn,
	) {}

	addSubscription(sub: Subscription, filter: EventFilter) {
		this.subs.set(sub.id, sub)
		this.filters.set(sub.id, filter)
		if (!this.runPromise) {
			this.runPromise = this.run()
		}
	}

	removeSubscription(id: string): boolean {
		const existed = this.subs.delete(id)
		this.filters.delete(id)
		return existed
	}

	isEmpty(): boolean {
		return this.subs.size === 0
	}

	getSubscriptions(): Subscription[] {
		return [...this.subs.values()]
	}

	async stop() {
		this.stopped = true
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		this.abortController?.abort()
		this.abortController = null
		if (this.runPromise) {
			try {
				await this.runPromise
			} catch {
				// run() already logs errors; swallow here to keep shutdown clean
			}
		}
	}

	private async run() {
		try {
			while (!this.stopped && this.subs.size > 0) {
				try {
					await this.connect()
					if (this.stopped || this.subs.size === 0) break
					await this.waitBackoff()
				} catch (err) {
					if (this.stopped) break
					if (isAbortError(err)) break
					if (isAuthError(err)) {
						console.error(
							`[maskin-mcp] SSE auth error (workspace ${this.workspaceId}):`,
							(err as Error).message,
						)
						await this.warn(
							this.workspaceId,
							'error',
							'Event subscription ended: authorization failed.',
						)
						for (const id of [...this.subs.keys()]) this.removeSubscription(id)
						break
					}
					console.error(
						`[maskin-mcp] SSE error (workspace ${this.workspaceId}):`,
						err instanceof Error ? err.message : err,
					)
					if (this.subs.size === 0) break
					await this.waitBackoff()
				}
			}
		} finally {
			this.runPromise = null
		}
	}

	private async waitBackoff() {
		this.reconnectAttempts++
		const attempt = Math.min(this.reconnectAttempts - 1, 5)
		const delay = Math.min(1000 * 2 ** attempt, 30000)
		await new Promise<void>((resolve) => {
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null
				resolve()
			}, delay)
		})
	}

	private async connect() {
		const controller = new AbortController()
		this.abortController = controller
		const url = `${this.config.apiBaseUrl}/api/events`
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.config.apiKey}`,
			'X-Workspace-Id': this.workspaceId,
			Accept: 'text/event-stream',
		}
		if (this.lastEventId) {
			headers['Last-Event-ID'] = this.lastEventId
		}

		const response = await fetch(url, {
			method: 'GET',
			headers,
			signal: controller.signal,
		})

		if (!response.ok) {
			throw new Error(`SSE connect failed: ${response.status}`)
		}

		this.reconnectAttempts = 0

		if (!response.body) {
			throw new Error('SSE response has no body')
		}

		const reader = response.body.getReader()
		// Cascade abort → reader cancel. Manually-constructed ReadableStreams
		// (and some runtimes' fetch bodies) don't always honor AbortController on
		// their own, so we wire it up explicitly.
		const onAbort = () => {
			reader.cancel().catch(() => {})
		}
		controller.signal.addEventListener('abort', onAbort)
		const decoder = new TextDecoder()
		let buffer = ''

		try {
			while (!this.stopped) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				const { frames, residual } = parseSSEChunk(buffer)
				buffer = residual
				for (const frame of frames) {
					await this.handleFrame(frame)
				}
			}
		} finally {
			controller.signal.removeEventListener('abort', onAbort)
			try {
				reader.releaseLock()
			} catch {
				// reader may already be released if the body was aborted
			}
			this.abortController = null
		}
	}

	private async handleFrame(frame: ParsedSSEFrame) {
		if (!frame.data) return
		let raw: Record<string, unknown>
		try {
			raw = JSON.parse(frame.data) as Record<string, unknown>
		} catch {
			return
		}
		const event = normalizeEvent(raw)
		if (frame.id) event.event_id = frame.id

		if (event.event_id && this.recentEventIds.includes(event.event_id)) return

		for (const [subId, sub] of this.subs) {
			const filter = this.filters.get(subId)
			if (!filter) continue
			if (!matchesFilter(event, filter)) continue
			try {
				await this.deliver(sub, event)
				sub.eventsDelivered++
			} catch (err) {
				sub.eventsDropped++
				console.error(
					`[maskin-mcp] Delivery failed for subscription ${subId}:`,
					err instanceof Error ? err.message : err,
				)
			}
		}

		if (event.event_id) {
			this.recentEventIds.push(event.event_id)
			if (this.recentEventIds.length > 256) this.recentEventIds.shift()
			this.lastEventId = event.event_id
		}
	}
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'))
}

function isAuthError(err: unknown): boolean {
	if (!(err instanceof Error)) return false
	return /\b40[13]\b/.test(err.message)
}

export function createSubscriptionRegistry(
	config: McpConfig,
	mcpServer: McpServer,
): SubscriptionRegistry {
	const streams = new Map<string, WorkspaceStream>()
	const subToWorkspace = new Map<string, string>()

	const deliver: DeliverFn = async (sub, event) => {
		await mcpServer.server.sendLoggingMessage({
			level: 'info',
			logger: 'maskin/events',
			data: {
				subscription_id: sub.id,
				workspace_id: sub.workspaceId,
				event,
			},
		})
	}

	const warn: WarnFn = async (workspaceId, level, message) => {
		try {
			await mcpServer.server.sendLoggingMessage({
				level,
				logger: 'maskin/events',
				data: { workspace_id: workspaceId, message },
			})
		} catch (err) {
			console.error(
				'[maskin-mcp] Warning delivery failed:',
				err instanceof Error ? err.message : err,
			)
		}
	}

	return {
		add(workspaceId, filter) {
			const sub: Subscription = {
				id: randomUUID(),
				workspaceId,
				filter,
				createdAt: new Date().toISOString(),
				eventsDelivered: 0,
				eventsDropped: 0,
			}
			let stream = streams.get(workspaceId)
			if (!stream) {
				stream = new WorkspaceStream(workspaceId, config, deliver, warn)
				streams.set(workspaceId, stream)
			}
			stream.addSubscription(sub, filter)
			subToWorkspace.set(sub.id, workspaceId)
			return sub
		},
		remove(id) {
			const workspaceId = subToWorkspace.get(id)
			if (!workspaceId) return false
			const stream = streams.get(workspaceId)
			if (!stream) return false
			const existed = stream.removeSubscription(id)
			subToWorkspace.delete(id)
			if (stream.isEmpty()) {
				void stream.stop()
				streams.delete(workspaceId)
			}
			return existed
		},
		list() {
			const all: Subscription[] = []
			for (const stream of streams.values()) {
				all.push(...stream.getSubscriptions())
			}
			return all
		},
		async shutdownAll() {
			const toStop = [...streams.values()]
			streams.clear()
			subToWorkspace.clear()
			await Promise.all(toStop.map((s) => s.stop()))
		},
	}
}
