import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type ManagedSSEStream, type ParsedSSEFrame, createManagedSSE } from './lib/managed-sse.js'

// Re-export for backwards compatibility with existing tests.
export { parseSSEChunk } from './lib/managed-sse.js'
export type { ParsedSSEFrame } from './lib/managed-sse.js'

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
	eventsFiltered: number
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

function parseEventFrame(frame: ParsedSSEFrame): { item?: MaskinEvent } | null {
	if (!frame.data) return null
	let raw: Record<string, unknown>
	try {
		raw = JSON.parse(frame.data) as Record<string, unknown>
	} catch {
		return null
	}
	const event = normalizeEvent(raw)
	if (frame.id) event.event_id = frame.id
	return { item: event }
}

export function createSubscriptionRegistry(
	config: McpConfig,
	mcpServer: McpServer,
): SubscriptionRegistry {
	// One ManagedSSEStream per workspace; multiple subscriptions fan out from it.
	const streams = new Map<string, ManagedSSEStream>()
	const subs = new Map<string, Subscription>()
	const filters = new Map<string, EventFilter>()
	const subToWorkspace = new Map<string, string>()

	function streamForWorkspace(workspaceId: string): ManagedSSEStream {
		let stream = streams.get(workspaceId)
		if (stream) return stream
		stream = createManagedSSE<MaskinEvent>({
			url: `${config.apiBaseUrl}/api/events`,
			headers: () => ({
				Authorization: `Bearer ${config.apiKey}`,
				'X-Workspace-Id': workspaceId,
				Accept: 'text/event-stream',
			}),
			parseFrame: parseEventFrame,
			onItem: async (event) => {
				// Workspace notifications (type: alert / recommendation / needs_input /
				// good_news) are user-facing by design — the `notifications` table
				// exists precisely to route things at the human. Elevate their
				// severity one rung above normal events so MCP clients that
				// distinguish log levels in their UI can surface them more
				// prominently. The PG NOTIFY trigger drops the full notification
				// payload to stay under the 8KB limit, so we can't distinguish the
				// subtypes here — treat the whole category as `warning`.
				const isNotification = event.entity_type === 'notification'
				const level = isNotification ? 'warning' : 'info'
				let firstDeliveryError: unknown = null
				for (const [subId, wsId] of subToWorkspace) {
					if (wsId !== workspaceId) continue
					const sub = subs.get(subId)
					const filter = filters.get(subId)
					if (!sub || !filter) continue
					if (!matchesFilter(event, filter)) {
						sub.eventsFiltered++
						continue
					}
					try {
						await mcpServer.server.sendLoggingMessage({
							level,
							logger: 'maskin/events',
							data: {
								subscription_id: sub.id,
								workspace_id: sub.workspaceId,
								event,
							},
						})
						sub.eventsDelivered++
					} catch (err) {
						sub.eventsDropped++
						if (firstDeliveryError === null) firstDeliveryError = err
						console.error(
							`[maskin-mcp] Delivery failed for subscription ${subId}:`,
							err instanceof Error ? err.message : err,
						)
					}
				}
				// Re-throw so managed-sse holds back lastEventId and the next reconnect
				// replays this event. The shared transport means a single delivery
				// failure usually implies the rest would too, so don't pretend success.
				if (firstDeliveryError !== null) throw firstDeliveryError
			},
			onWarn: async (level, message) => {
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
			},
			onTerminal: () => {
				// Wipe all subs tied to this workspace — they can never deliver again.
				streams.delete(workspaceId)
				for (const [subId, wsId] of [...subToWorkspace.entries()]) {
					if (wsId === workspaceId) {
						subs.delete(subId)
						filters.delete(subId)
						subToWorkspace.delete(subId)
					}
				}
			},
			replayCap: 100,
			logTag: `workspace ${workspaceId}`,
		})
		streams.set(workspaceId, stream)
		return stream
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
				eventsFiltered: 0,
			}
			subs.set(sub.id, sub)
			filters.set(sub.id, filter)
			subToWorkspace.set(sub.id, workspaceId)
			streamForWorkspace(workspaceId).addRef(sub.id)
			return sub
		},
		remove(id) {
			const workspaceId = subToWorkspace.get(id)
			if (!workspaceId) return false
			const stream = streams.get(workspaceId)
			if (!stream) {
				// Stream already torn down (terminal onTerminal path ran); the sub
				// should already be gone from the maps. Return false so callers can
				// treat this as "not found".
				subs.delete(id)
				filters.delete(id)
				subToWorkspace.delete(id)
				return false
			}
			const existed = stream.removeRef(id)
			subs.delete(id)
			filters.delete(id)
			subToWorkspace.delete(id)
			if (!stream.hasRefs()) {
				void stream.stop()
				streams.delete(workspaceId)
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
			filters.clear()
			subToWorkspace.clear()
			await Promise.all(toStop.map((s) => s.stop()))
		},
	}
}
