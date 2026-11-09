import type { Database } from '@maskin/db'
import { mcpTelemetry } from '@maskin/db/schema'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// PostHog event for old-name use in the MCP tool-surface bet. An alias hit is a
// success, so it is deliberately not one of the misfire events.
const POSTHOG_EVENT_NAME = 'mcp_alias_use'

export interface McpAliasUse {
	toolName: string
	sessionId: string | null
	transport: 'stdio' | 'http' | null
	renames: { old: string; new: string }[]
	bothSent: boolean
	droppedKeys: string[]
	toolAlias: { old: string; new: string } | null
	// From the authenticated request, never from the payload.
	agentActorId: string | null
}

// Best-effort persistence + PostHog fan-out. Postgres is the source of truth
// (PostHog has been dark since 4 Oct), so it is written first; the PostHog call
// follows whether or not the insert worked. Neither failure path throws — the
// caller sits on the telemetry ingest path and an outage must not surface a 5xx
// to the sink.
export async function recordMcpAliasUse(
	db: Database | undefined,
	workspaceId: string,
	event: McpAliasUse,
): Promise<void> {
	if (db) {
		try {
			await db.insert(mcpTelemetry).values({
				workspaceId,
				eventType: 'alias_use',
				toolName: event.toolName,
				sessionId: event.sessionId ?? null,
				data: {
					renames: event.renames,
					both_sent: event.bothSent,
					dropped_keys: event.droppedKeys,
					tool_alias: event.toolAlias,
					agent_actor_id: event.agentActorId,
					transport: event.transport,
				},
			})
		} catch (err) {
			logger.warn('mcp alias_use persist failed', {
				tool: event.toolName,
				error: String(err),
			})
		}
	}
	const distinctId = event.agentActorId ?? workspaceId
	void capturePosthogEvent(POSTHOG_EVENT_NAME, distinctId, {
		workspace_id: workspaceId,
		agent_actor_id: event.agentActorId,
		tool_name: event.toolName,
		session_id: event.sessionId,
		transport: event.transport,
		both_sent: event.bothSent,
		// Names only. Serialised like requested_shape on the misfire events so a
		// dashboard reads both the same way.
		renames: JSON.stringify(event.renames),
		dropped_keys: JSON.stringify(event.droppedKeys),
		tool_alias: event.toolAlias ? JSON.stringify(event.toolAlias) : null,
	})
}
