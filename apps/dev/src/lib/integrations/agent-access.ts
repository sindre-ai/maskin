import type { Database, Transaction } from '@maskin/db'
import {
	type AgentGrantAccess,
	type IntegrationDefaultAccess,
	type IntegrationProviderMode,
	actors,
	agentGrants,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, asc, eq, inArray } from 'drizzle-orm'

/**
 * What one actor may do with one integration. The single place that answers it.
 *
 * - Keychain credentials (byo_*) are explicit-grant: any agent_grants row means
 *   on (read_write), no row means off. There is no read/write split for a raw key
 *   or login, because it is injected as an env var and "read" could not stop a write.
 * - Every other integration: the agent's row if it has one, else the integration's
 *   default_agent_access ('read' unless a person switched it to 'none').
 * - People are not subject to grants on ordinary integrations; a Keychain credential
 *   needs an explicit grant for anyone.
 */
export type AgentAccess = 'none' | AgentGrantAccess

export const canRead = (a: AgentAccess): boolean => a === 'read' || a === 'read_write'
export const canWrite = (a: AgentAccess): boolean => a === 'write' || a === 'read_write'
export const hasAnyAccess = (a: AgentAccess): boolean => a !== 'none'

export function isKeychainMode(mode: IntegrationProviderMode): boolean {
	return mode !== 'registered'
}

/** Pure: the access an agent gets given its row (or none) and the integration's settings. */
export function effectiveAccess(
	integration: {
		providerMode: IntegrationProviderMode
		defaultAgentAccess: IntegrationDefaultAccess
	},
	grant: AgentGrantAccess | null,
): AgentAccess {
	if (isKeychainMode(integration.providerMode)) return grant ? 'read_write' : 'none'
	return grant ?? integration.defaultAgentAccess
}

/**
 * Access for one actor on one integration, or null when the integration is not in
 * the workspace. A person resolves to read_write on an ordinary integration.
 */
export async function resolveAgentAccess(
	db: Database | Transaction,
	workspaceId: string,
	integrationId: string,
	actorId: string,
): Promise<AgentAccess | null> {
	const [row] = await db
		.select({
			providerMode: integrations.providerMode,
			defaultAgentAccess: integrations.defaultAgentAccess,
			actorType: actors.type,
			grant: agentGrants.access,
		})
		.from(integrations)
		.leftJoin(actors, eq(actors.id, actorId))
		.leftJoin(
			agentGrants,
			and(eq(agentGrants.integrationId, integrations.id), eq(agentGrants.actorId, actorId)),
		)
		.where(and(eq(integrations.id, integrationId), eq(integrations.workspaceId, workspaceId)))
		.limit(1)
	if (!row) return null
	// An actor that does not exist gets nothing, whatever the integration.
	if (row.actorType === null) return 'none'
	// A saved key or login needs an explicit grant for anyone. Other integrations let people through.
	if (row.actorType !== 'agent' && !isKeychainMode(row.providerMode)) return 'read_write'
	return effectiveAccess(row, row.grant)
}

export interface ActorIntegrationAccess {
	integrationId: string
	provider: string
	providerMode: IntegrationProviderMode
	displayName: string | null
	access: AgentAccess
}

/**
 * Access for one actor across every live integration in the workspace. Used at
 * session launch to tell the agent up front what it may do. Oldest first.
 */
export async function listAgentAccess(
	db: Database | Transaction,
	workspaceId: string,
	actorId: string,
): Promise<ActorIntegrationAccess[]> {
	const rows = await db
		.select({
			integrationId: integrations.id,
			provider: integrations.provider,
			providerMode: integrations.providerMode,
			displayName: integrations.displayName,
			defaultAgentAccess: integrations.defaultAgentAccess,
			grant: agentGrants.access,
		})
		.from(integrations)
		.leftJoin(
			agentGrants,
			and(eq(agentGrants.integrationId, integrations.id), eq(agentGrants.actorId, actorId)),
		)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				inArray(integrations.status, ['active', 'pending_undo']),
			),
		)
		.orderBy(asc(integrations.createdAt))
	return rows.map((r) => ({
		integrationId: r.integrationId,
		provider: r.provider,
		providerMode: r.providerMode,
		displayName: r.displayName,
		access: effectiveAccess(r, r.grant),
	}))
}

/** Whether every actor id is an agent in the workspace. Grants name agents only. */
export async function actorsAreWorkspaceAgents(
	db: Database | Transaction,
	workspaceId: string,
	actorIds: string[],
): Promise<boolean> {
	const unique = [...new Set(actorIds)]
	if (unique.length === 0) return true
	const rows = await db
		.select({ id: actors.id })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.type, 'agent'),
				inArray(actors.id, unique),
			),
		)
	return rows.length === unique.length
}
