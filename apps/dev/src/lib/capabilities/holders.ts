import type { Database } from '@maskin/db'
import { actors, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { transportOf } from '../actor-tools-redaction'
import { getProvider, listProviders } from '../integrations/registry'
import type { IntegrationConfig } from '../types'
import { isWorkspaceHumanAdminOrOwner, isWorkspaceMember } from '../workspace-auth'

/**
 * The single place that answers "which agents may use this source" and "who may
 * be told about it". Nothing else in lib/capabilities/, the scanner, the digest
 * or the proactive-message service reads agent tool config, per-integration
 * exposure switches or a grants table. A static guard test fails the build if
 * one does (capabilities-holders-guard.test.ts).
 *
 * Contract (tech spec section 13): holdersOf, holdersForSources, visibleHolders
 * and recipientCanAct. countUnscannedServers is a fifth export that exists only
 * because the unscanned_servers figure on the scan event has to read the same
 * agent config, and that read must live here.
 *
 * Two implementations sit behind one constant. AgentConfigHolders reads each
 * agent's own config and ships now. WorkspaceGrantHolders is a seam for the
 * shared-tools bet, which owns flipping HOLDERS_IMPLEMENTATION and the parity
 * test. Nothing here writes agent config, integrations or grants.
 */

/** Where a source's holders are resolved from. Source keys never change at cutover. */
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

interface HolderResolver {
	holdersForSources(
		ctx: HolderContext,
		sources: readonly HolderSource[],
	): Promise<Map<string, string[]>>
	countUnscannedServers(ctx: HolderContext): Promise<number>
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ActiveAgent {
	id: string
	mcpServers: JsonRecord[]
}

/**
 * Active agents of the workspace: members whose actor type is agent. There is
 * no deactivated or archived column on actors today; a removed agent is a
 * deleted membership. A paused agent still holds its tools.
 */
async function loadActiveAgents(ctx: HolderContext): Promise<ActiveAgent[]> {
	const rows = await ctx.db
		.select({ id: actors.id, tools: actors.tools })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(actors.type, 'agent')))
	return rows.map((row) => {
		const servers =
			isRecord(row.tools) && isRecord(row.tools.mcpServers)
				? Object.values(row.tools.mcpServers).filter(isRecord)
				: []
		return { id: row.id, mcpServers: servers }
	})
}

const GITHUB_STDIO_COMMAND = 'github-mcp-server'
const MASKIN_API_URL_PLACEHOLDER = '${MASKIN_API_URL}'

function coveredByProviderSource(server: JsonRecord): boolean {
	if (server.command === GITHUB_STDIO_COMMAND) return true
	// An entry that points back at this API is the built-in Maskin server or an in-process
	// integration server; both are scanned as their own sources.
	if (typeof server.url === 'string' && server.url.startsWith(MASKIN_API_URL_PLACEHOLDER))
		return true
	if (typeof server.url === 'string' && server.url.includes('/api/integrations/')) return true
	const transport = transportOf(server)
	return listProviders().some((p) => {
		const spec = p.config.mcp?.server
		return spec ? transportOf({ ...spec }) === transport : false
	})
}

class AgentConfigHolders implements HolderResolver {
	async holdersForSources(
		ctx: HolderContext,
		sources: readonly HolderSource[],
	): Promise<Map<string, string[]>> {
		const result = new Map<string, string[]>()
		if (sources.length === 0) return result
		const agents = await loadActiveAgents(ctx)
		const allIds = agents.map((a) => a.id).sort()

		for (const source of sources) {
			if (source.key === 'maskin:builtin') {
				// Built-in Maskin tools: no per-agent restriction exists, so every active agent.
				result.set(source.key, allIds)
				continue
			}
			if (!source.provider || !source.integrationId) {
				result.set(source.key, [])
				continue
			}
			const [row] = await ctx.db
				.select({ config: integrations.config })
				.from(integrations)
				.where(
					and(
						eq(integrations.id, source.integrationId),
						eq(integrations.workspaceId, ctx.workspaceId),
					),
				)
				.limit(1)
			if (!row) {
				result.set(source.key, [])
				continue
			}
			// The credential stays usable server-side but sessions get no tools.
			if ((row.config as IntegrationConfig | null)?.expose_to_agent_sessions === false) {
				result.set(source.key, [])
				continue
			}
			let mcp: ReturnType<typeof getProvider>['config']['mcp']
			try {
				mcp = getProvider(source.provider).config.mcp
			} catch {
				result.set(source.key, [])
				continue
			}
			if (mcp?.autoInject) {
				result.set(source.key, allIds)
				continue
			}
			if (mcp?.server) {
				const want = transportOf({ ...mcp.server })
				result.set(
					source.key,
					agents
						.filter((a) => a.mcpServers.some((s) => transportOf(s) === want))
						.map((a) => a.id)
						.sort(),
				)
				continue
			}
			result.set(source.key, [])
		}
		return result
	}

	async countUnscannedServers(ctx: HolderContext): Promise<number> {
		const agents = await loadActiveAgents(ctx)
		const distinct = new Set<string>()
		for (const agent of agents) {
			for (const server of agent.mcpServers) {
				if (!coveredByProviderSource(server)) distinct.add(transportOf(server))
			}
		}
		return distinct.size
	}
}

/**
 * Seam for the shared-tools bet. A workspace grant is the only way an agent
 * holds a workspace server once that bet ships; during rollout the answer is
 * the union of grants and not-yet-migrated per-agent entries. Deliberately not
 * built: the grant model does not exist yet.
 */
class WorkspaceGrantHolders implements HolderResolver {
	holdersForSources(): Promise<Map<string, string[]>> {
		return Promise.reject(new Error('WorkspaceGrantHolders is not built: no grant model yet'))
	}
	countUnscannedServers(): Promise<number> {
		return Promise.reject(new Error('WorkspaceGrantHolders is not built: no grant model yet'))
	}
}

/** The one switch. The shared-tools bet changes this line and ships a parity test with it. */
const HOLDERS_IMPLEMENTATION: 'agent_config' | 'workspace_grants' = 'agent_config'

function resolver(): HolderResolver {
	return HOLDERS_IMPLEMENTATION === 'workspace_grants'
		? new WorkspaceGrantHolders()
		: new AgentConfigHolders()
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
	const map = await resolver().holdersForSources(ctx, [source])
	return map.get(source.key) ?? []
}

/** Batch form: one agent read per call. Missing keys mean no holders. */
export function holdersForSources(
	ctx: HolderContext,
	sources: readonly HolderSource[],
): Promise<Map<string, string[]>> {
	return resolver().holdersForSources(ctx, sources)
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
	const agents = await loadActiveAgents(ctx)
	const known = new Set(agents.map((a) => a.id))
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

/** Distinct hand-attached server transports that no provider source covers. */
export function countUnscannedServers(ctx: HolderContext): Promise<number> {
	return resolver().countUnscannedServers(ctx)
}
