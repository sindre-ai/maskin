import type { Database } from '@maskin/db'
import { events, actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { logger } from '../logger'

/**
 * Strips a provider's in-process MCP server entry from every agent in a
 * workspace when that provider is disconnected.
 *
 * Some providers are served by an MCP endpoint this API hosts itself —
 * `/api/integrations/<provider>/mcp` (LinkedIn, Slack). Agents attach them by
 * copying a preset into `actors.tools.mcpServers`, which is a snapshot: it
 * keeps pointing at the endpoint long after the credential behind it is gone.
 * The agent then boots with the server configured, its tools appear in the
 * tool list, and every call fails — the worst shape of failure, because the
 * agent believes it has a capability it does not and reports a broken platform
 * rather than a missing connection.
 *
 * Entries are matched on the endpoint URL, not the key name. The key is
 * user-editable (an agent can attach the same server under any name), while
 * the URL is what actually determines where the calls go — so matching on the
 * URL removes a renamed entry and, equally important, leaves alone a
 * hand-written server that merely happens to share the name.
 *
 * Reconnecting does NOT re-attach: the agent's tool list is the user's to
 * curate, and silently re-adding a server someone may have deliberately
 * removed would be the same overreach in the other direction.
 */

/** The endpoint shape this API serves per-provider MCP on. */
function providerMcpPath(provider: string): string {
	return `/api/integrations/${provider}/mcp`
}

type McpServerEntry = { url?: unknown } & Record<string, unknown>

function entryTargetsProvider(entry: unknown, provider: string): boolean {
	if (!entry || typeof entry !== 'object') return false
	const url = (entry as McpServerEntry).url
	if (typeof url !== 'string') return false
	return url.includes(providerMcpPath(provider))
}

/**
 * Removes the provider's MCP entry from every agent in the workspace.
 * Returns the number of agents changed.
 *
 * Never throws: this runs after the disconnect has already committed, and a
 * failure to tidy an agent's config must not fail the disconnect the user
 * asked for. A miss leaves the pre-existing (pre-fix) behaviour, not a
 * corrupt one.
 */
export async function detachProviderMcpServers(
	db: Database,
	workspaceId: string,
	provider: string,
	/** The actor performing the disconnect — recorded on the audit event. */
	actorId: string,
): Promise<number> {
	try {
		const rows = await db
			.select({ id: actors.id, name: actors.name, tools: actors.tools })
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'agent')))

		let changed = 0
		for (const row of rows) {
			const tools = (row.tools ?? {}) as Record<string, unknown>
			const servers = tools.mcpServers
			if (!servers || typeof servers !== 'object') continue

			const kept: Record<string, unknown> = {}
			const removed: string[] = []
			for (const [key, entry] of Object.entries(servers as Record<string, unknown>)) {
				if (entryTargetsProvider(entry, provider)) removed.push(key)
				else kept[key] = entry
			}
			if (removed.length === 0) continue

			await db
				.update(actors)
				.set({ tools: { ...tools, mcpServers: kept }, updatedAt: new Date() })
				.where(eq(actors.id, row.id))

			// Per the events-on-every-mutation rule: without this the agent's
			// tool surface changes with no audit trail and no SSE invalidation,
			// so an open agent page keeps rendering the detached server.
			await db.insert(events).values({
				workspaceId,
				actorId,
				action: 'updated',
				entityType: 'actor',
				entityId: row.id,
				data: { mcp_servers_detached: removed, reason: 'integration_disconnected', provider },
			})

			changed += 1
			logger.info('Detached MCP server from agent after integration disconnect', {
				workspaceId,
				provider,
				agentActorId: row.id,
				removed,
			})
		}
		return changed
	} catch (err) {
		logger.error('Failed to detach provider MCP servers after disconnect', {
			workspaceId,
			provider,
			error: err instanceof Error ? err.message : String(err),
		})
		return 0
	}
}
