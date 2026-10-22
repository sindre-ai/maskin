import type { Database } from '@maskin/db'
import {
	INTEGRATION_STATUS_ACTIVE,
	type Integration,
	actors,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq, ne } from 'drizzle-orm'
import { recordEvent } from '../events/record-event'
import { logger } from '../logger'
import { entryMatcherFor } from './mcp-entries'
import { getProvider } from './registry'

/**
 * Strips the MCP entries a disconnected integration put on agents.
 *
 * Agents attach a provider by copying its preset into
 * `actors.tools.mcpServers`, which is a snapshot: it keeps pointing at the
 * server long after the credential behind it is gone. The agent then boots with
 * the server configured, its tools appear in the tool list, and every call
 * fails — the worst shape of failure, because the agent believes it has a
 * capability it does not and reports a broken platform rather than a missing
 * connection.
 *
 * What counts as "this integration's entry" is declared by the provider in its
 * own `config.ts` and applied by `mcp-entries.ts`, the same for every provider.
 * Two rules come with that:
 *
 * - Only the disconnected credential's own entries go. A workspace can hold
 *   several active rows per provider (LinkedIn identities, GitHub
 *   installations, a second Slack team), and disconnecting one must not strip
 *   what another still needs.
 * - Entries are matched on what they point at, not the key an agent filed them
 *   under (see `mcp-entries.ts`).
 *
 * Reconnecting does NOT re-attach: the agent's tool list is the user's to
 * curate, and silently re-adding a server someone may have deliberately
 * removed would be the same overreach in the other direction.
 */

/** The fields of the disconnected row that detach reads. */
export type DetachedIntegration = Pick<
	Integration,
	'id' | 'workspaceId' | 'provider' | 'config' | 'unipileAccSlug'
>

/**
 * Removes the disconnected integration's MCP entries from every agent in its
 * workspace. Returns the number of agents changed.
 *
 * Never throws: this runs after the disconnect has already committed, and a
 * failure to tidy an agent's config must not fail the disconnect the user
 * asked for. A miss leaves the pre-existing (pre-fix) behaviour, not a
 * corrupt one.
 */
export async function detachProviderMcpServers(
	db: Database,
	integration: DetachedIntegration,
	/** The actor performing the disconnect — recorded on the audit event. */
	actorId: string,
): Promise<number> {
	const { workspaceId, provider } = integration
	try {
		const others = await db
			.select({ config: integrations.config, unipileAccSlug: integrations.unipileAccSlug })
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, provider),
					eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
					ne(integrations.id, integration.id),
				),
			)
		const matches = entryMatcherFor(getProvider(provider).config, integration, others)
		if (!matches) return 0

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
				if (matches(entry)) removed.push(key)
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
			await recordEvent(db, {
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
