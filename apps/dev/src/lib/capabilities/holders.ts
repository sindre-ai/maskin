import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describeAgentAccess } from '../integrations/agent-access-view'
import { CUSTOM_MCP_PROVIDER } from '../integrations/custom-mcp'
import { isWorkspaceHumanAdminOrOwner, isWorkspaceMember } from '../workspace-auth'

/**
 * The single place that answers "which agents may use this source" and "who may
 * be told about it". Nothing else in lib/capabilities/, the scanner, the digest
 * or the proactive-message service reads agent grants, per-integration access
 * defaults or agent tool config. A static guard test fails the build if one does
 * (holders-guard.test.ts).
 *
 * Contract (tech spec section 13): holdersOf, holdersForSources, visibleHolders
 * and recipientCanAct. countUnscannedServers is a fifth export that exists only
 * because the unscanned_servers figure on the scan event has to read the same
 * access answer, and that read must live here.
 *
 * An agent holds a source when main's own answer says its server is attached to
 * the agent's sessions (describeAgentAccess in integrations/agent-access-view).
 * That answer applies the per-agent grant, the workspace default and the
 * is-the-server-attached rule. Nothing here copies any of them, so the scan and
 * a real session cannot disagree. Nothing here writes agent config,
 * integrations or grants.
 */

/** Where a source's holders are resolved from. Source keys never change. */
export interface HolderSource {
	/** maskin:builtin or integration:{provider}:{integrationId}. */
	key: string
	provider?: string
	integrationId?: string
}

export interface HolderContext {
	db: Database
	workspaceId: string
}

/**
 * Active agents of the workspace: members whose actor type is agent. There is
 * no deactivated or archived column on actors today; a removed agent is a
 * deleted membership. A paused agent still holds its tools.
 */
async function loadActiveAgentIds(ctx: HolderContext): Promise<string[]> {
	const rows = await ctx.db
		.select({ id: actors.id })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(actors.type, 'agent')))
	return rows.map((row) => row.id).sort()
}

interface AttachedIntegration {
	provider: string
	agentIds: string[]
}

/**
 * For each integration of the workspace, the agents whose session gets its
 * server, from main's access answer. One answer per agent, read once per call.
 */
async function attachedByIntegration(
	ctx: HolderContext,
	agentIds: readonly string[],
): Promise<Map<string, AttachedIntegration>> {
	const attached = new Map<string, AttachedIntegration>()
	for (const agentId of agentIds) {
		const view = await describeAgentAccess(ctx.db, ctx.workspaceId, agentId)
		for (const integration of view.integrations) {
			const entry = attached.get(integration.integration_id) ?? {
				provider: integration.provider,
				agentIds: [],
			}
			if (integration.server_attached) entry.agentIds.push(agentId)
			attached.set(integration.integration_id, entry)
		}
	}
	return attached
}

/**
 * Agent ids that may use the source. toolName is ignored in v1 (grants are per
 * server) but stays in the signature so finer grants never change a caller.
 */
export async function holdersOf(
	ctx: HolderContext,
	source: HolderSource,
	_toolName?: string,
): Promise<string[]> {
	const map = await holdersForSources(ctx, [source])
	return map.get(source.key) ?? []
}

/** Batch form: one access read per agent per call. Missing keys mean no holders. */
export async function holdersForSources(
	ctx: HolderContext,
	sources: readonly HolderSource[],
): Promise<Map<string, string[]>> {
	const result = new Map<string, string[]>()
	if (sources.length === 0) return result
	const agentIds = await loadActiveAgentIds(ctx)
	const needsIntegrations = sources.some((s) => s.key !== 'maskin:builtin')
	const attached = needsIntegrations
		? await attachedByIntegration(ctx, agentIds)
		: new Map<string, AttachedIntegration>()

	for (const source of sources) {
		if (source.key === 'maskin:builtin') {
			// Built-in Maskin tools: locked on for every agent (describeAgentAccess.maskin_mcp).
			result.set(source.key, agentIds)
			continue
		}
		const entry = source.integrationId ? attached.get(source.integrationId) : undefined
		result.set(source.key, entry ? [...entry.agentIds].sort() : [])
	}
	return result
}

/**
 * The subset of agentIds the recipient can already see in the workspace agent
 * list. Fails closed: a recipient who is not a member of the workspace sees
 * nothing, and an id that is not an agent member of the workspace is dropped.
 *
 * Today every member sees every agent (the workspace actor list applies no
 * per-member filter), so for a member this is a membership check and nothing
 * more. If hiding is ever added and the rule is unclear, drop the name here.
 */
export async function visibleHolders(
	ctx: HolderContext,
	recipientId: string,
	agentIds: readonly string[],
): Promise<string[]> {
	if (agentIds.length === 0) return []
	if (!(await isWorkspaceMember(ctx.db, recipientId, ctx.workspaceId))) return []
	const known = new Set(await loadActiveAgentIds(ctx))
	return agentIds.filter((id) => known.has(id))
}

/**
 * Whether the recipient may act on a reconnect or a not-attached integration.
 * Delegates to the existing workspace-auth human role check, so agents are
 * never true and there is no second role list.
 */
export function recipientCanAct(ctx: HolderContext, recipientId: string): Promise<boolean> {
	return isWorkspaceHumanAdminOrOwner(ctx.db, recipientId, ctx.workspaceId)
}

/**
 * Hand-added tool servers the scan cannot probe. Hand-added servers live on the
 * workspace as custom-mcp integrations (main moved them off the agents), and no
 * provider source covers them. Counts those at least one agent can use.
 */
export async function countUnscannedServers(ctx: HolderContext): Promise<number> {
	const attached = await attachedByIntegration(ctx, await loadActiveAgentIds(ctx))
	let count = 0
	for (const entry of attached.values()) {
		if (entry.provider === CUSTOM_MCP_PROVIDER && entry.agentIds.length > 0) count++
	}
	return count
}
