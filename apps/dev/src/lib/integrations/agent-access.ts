import type { Database, Transaction } from '@maskin/db'
import {
	type AgentGrantAccess,
	type IntegrationDefaultAccess,
	type IntegrationProviderMode,
	actors,
	agentChatGrants,
	agentGrants,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { isGatedRow } from './custom-mcp'

/**
 * What one actor may do with one integration. The single place that answers it.
 *
 * - Keychain credentials (byo_*) are on or off: the agent's own row if it has one
 *   ('none' is off, anything else is on, read_write), else the credential's default
 *   ('read' is on for every agent without a row, 'none' is off). Every credential starts
 *   at 'none', so it is fail-closed until a person grants it. There is no read/write split
 *   for a raw key or login, because it is injected as an env var and "read" could not stop a write.
 * - Every other integration: the agent's row if it has one, else the integration's
 *   default_agent_access ('read' unless a person switched it to 'none').
 * - People are not subject to grants on ordinary integrations; a Keychain credential
 *   needs an explicit grant for anyone.
 */
export type AgentAccess = 'none' | AgentGrantAccess

export const canRead = (a: AgentAccess): boolean => a === 'read' || a === 'read_write'
/** May use the integration's write tools. Where an action cannot be undone it still asks a person. */
export const canWrite = (a: AgentAccess): boolean => a === 'read_write'
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
	// A saved key or login is on or off: its own row decides, else the default does.
	if (isKeychainMode(integration.providerMode)) {
		if (grant) return grant === 'none' ? 'none' : 'read_write'
		return integration.defaultAgentAccess === 'read' ? 'read_write' : 'none'
	}
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
	/** Where the access is used, so a chat-scoped Allow for this conversation counts. */
	opts: { conversationId?: string | null } = {},
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
	const access = effectiveAccess(row, row.grant)
	if (access === 'none' && isKeychainMode(row.providerMode) && opts.conversationId) {
		const [chat] = await db
			.select({ id: agentChatGrants.id })
			.from(agentChatGrants)
			.where(
				and(
					eq(agentChatGrants.integrationId, integrationId),
					eq(agentChatGrants.actorId, actorId),
					eq(agentChatGrants.conversationId, opts.conversationId),
				),
			)
			.limit(1)
		if (chat) return 'read_write'
	}
	return access
}

export interface ActorIntegrationAccess {
	integrationId: string
	provider: string
	providerMode: IntegrationProviderMode
	displayName: string | null
	access: AgentAccess
	/** Where it comes from: the agent's own entry, the integration's default, or an Allow for one chat. */
	source: 'grant' | 'default' | 'chat'
	/** Saved credentials: in how many chats it is shared with this agent, apart from any grant. */
	chatCount: number
	defaultAgentAccess: IntegrationDefaultAccess
	status: string
	/** Who connected or saved it: with workspace admins, the people who may change access. */
	createdBy: string
	/** False when the integration is switched off for agent sessions. */
	exposed: boolean
	/** A custom tool server Maskin sits in front of (has Read / Read & write / No access). */
	gated: boolean
	/** Which account this is when a provider can be connected more than once (GitHub: the org). */
	accountLabel?: string | null
}

/**
 * Whether an integration's MCP server is attached to an agent's session. The one rule:
 * session launch uses it to attach, and every screen and tool that says "attached" uses it
 * to report, so they cannot disagree. `hasServer` is whether the provider has a server to
 * attach at all (a provider with only an API, like Skjald, has none).
 */
export function attachesServer(
	row: {
		providerMode: IntegrationProviderMode
		status: string
		exposed: boolean
		access: AgentAccess
	},
	hasServer: boolean,
): boolean {
	return (
		hasServer &&
		row.providerMode === 'registered' &&
		row.status === 'active' &&
		row.exposed &&
		row.access !== 'none'
	)
}

/**
 * Access for one actor across every live integration in the workspace. Used at
 * session launch to tell the agent up front what it may do. Oldest first.
 */
export async function listAgentAccess(
	db: Database | Transaction,
	workspaceId: string,
	actorId: string,
	opts: { conversationId?: string | null } = {},
): Promise<ActorIntegrationAccess[]> {
	const chatRows = await db
		.select({
			integrationId: agentChatGrants.integrationId,
			conversationId: agentChatGrants.conversationId,
		})
		.from(agentChatGrants)
		.where(and(eq(agentChatGrants.workspaceId, workspaceId), eq(agentChatGrants.actorId, actorId)))
	const chatsBy = new Map<string, string[]>()
	for (const g of chatRows) {
		chatsBy.set(g.integrationId, [...(chatsBy.get(g.integrationId) ?? []), g.conversationId])
	}
	const rows = await db
		.select({
			integrationId: integrations.id,
			provider: integrations.provider,
			providerMode: integrations.providerMode,
			displayName: integrations.displayName,
			defaultAgentAccess: integrations.defaultAgentAccess,
			status: integrations.status,
			createdBy: integrations.createdBy,
			config: integrations.config,
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
	return rows.map((r) => {
		const chats = chatsBy.get(r.integrationId) ?? []
		const keychain = isKeychainMode(r.providerMode)
		const viaChat =
			keychain && !r.grant && !!opts.conversationId && chats.includes(opts.conversationId)
		return {
			integrationId: r.integrationId,
			provider: r.provider,
			providerMode: r.providerMode,
			displayName: r.displayName,
			access: viaChat ? ('read_write' as const) : effectiveAccess(r, r.grant),
			source: viaChat ? ('chat' as const) : r.grant ? ('grant' as const) : ('default' as const),
			chatCount: keychain ? chats.length : 0,
			defaultAgentAccess: r.defaultAgentAccess,
			status: r.status,
			createdBy: r.createdBy,
			exposed:
				(r.config as { expose_to_agent_sessions?: boolean } | null)?.expose_to_agent_sessions !==
				false,
			gated: isGatedRow(r.config),
			accountLabel: accountLabelOf(r.config),
		}
	})
}

/** The org or login an install belongs to, when the provider stores one (GitHub). */
function accountLabelOf(config: unknown): string | null {
	const login = (config as { owner_login?: unknown } | null)?.owner_login
	return typeof login === 'string' && login.length > 0 ? login : null
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
