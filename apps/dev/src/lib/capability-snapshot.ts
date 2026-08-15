import type { Database } from '@maskin/db'
import {
	actors,
	agentSkills,
	integrations,
	triggers,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import {
	type AgentCapability,
	type AgentCapabilitySnapshot,
	type CapabilityCompact,
	type McpServerLike,
	scoreAgentCapability,
} from '@maskin/shared'
import { and, count, eq, inArray } from 'drizzle-orm'
import { listProviders } from './integrations'

/**
 * Env vars session-manager sets on every agent container regardless of what
 * integrations are connected. Any `${VAR}` reference to one of these should
 * always resolve, so the Connectors dimension should not surface them as
 * "unresolved placeholders". Mirrors the RESERVED_ENV_KEYS set in
 * `services/session-manager.ts` for the always-injected slice.
 */
const SYSTEM_ALWAYS_AVAILABLE_ENV_KEYS: readonly string[] = [
	'MASKIN_API_KEY',
	'MASKIN_API_URL',
	'MASKIN_WORKSPACE_ID',
	'BROWSER_CDP_URL',
]

/**
 * Env var names that a provider's MCP server config declares (`mcp.envKey`).
 * Static — provider registry is compiled in — so we can pre-index by
 * provider name once per process.
 */
function buildProviderEnvKeyIndex(): Map<string, string[]> {
	const index = new Map<string, string[]>()
	for (const provider of listProviders()) {
		const keys: string[] = []
		const envKey = provider.config.mcp?.envKey
		if (envKey) keys.push(envKey)
		// Providers with a hosted MCP endpoint reuse the same OAuth token under
		// their `envKey`; nothing else to add. GitHub is the outlier: its MCP
		// server reads from GITHUB_PERSONAL_ACCESS_TOKEN specifically, and
		// session-manager also injects a bare GITHUB_TOKEN for the `gh` CLI.
		// Surface both so agent configs that reference either resolve.
		if (provider.config.name === 'github') {
			keys.push('GITHUB_PERSONAL_ACCESS_TOKEN')
		}
		index.set(provider.config.name, keys)
	}
	return index
}

const PROVIDER_ENV_KEY_INDEX = buildProviderEnvKeyIndex()

/**
 * Extract the `mcpServers` block from `actors.tools` in the shape the
 * capability scorer expects. `tools` is a jsonb column — narrow it here so
 * callers can pass the raw column value.
 */
function extractMcpServers(tools: unknown): Record<string, McpServerLike> | null {
	if (!tools || typeof tools !== 'object') return null
	const mcp = (tools as { mcpServers?: unknown }).mcpServers
	if (!mcp || typeof mcp !== 'object') return null
	return mcp as Record<string, McpServerLike>
}

function extractMemoryKeys(memory: unknown): string[] {
	if (!memory || typeof memory !== 'object') return []
	return Object.keys(memory as Record<string, unknown>)
}

function extractModel(llmConfig: unknown): string | null {
	if (!llmConfig || typeof llmConfig !== 'object') return null
	const model = (llmConfig as { model?: unknown }).model
	return typeof model === 'string' && model.length > 0 ? model : null
}

function extractInLoop(metadata: unknown): boolean {
	if (!metadata || typeof metadata !== 'object') return false
	const id = (metadata as { installed_loop_id?: unknown }).installed_loop_id
	return typeof id === 'string' && id.length > 0
}

interface ActorRowForSnapshot {
	id: string
	type: string
	systemPrompt: string | null
	description: string | null
	tools: unknown
	memory: unknown
	llmProvider: string | null
	llmConfig: unknown
	metadata: unknown
}

/**
 * Set of workspace ids to scope integration lookups. When empty, the agent
 * has no membership rows and no active integrations resolve — the connectors
 * dimension will surface unresolved placeholders for anything the agent's
 * mcpServers config references beyond the system baseline.
 */
export function buildAvailableEnvKeys(activeProviderNames: readonly string[]): string[] {
	const set = new Set<string>(SYSTEM_ALWAYS_AVAILABLE_ENV_KEYS)
	for (const name of activeProviderNames) {
		const keys = PROVIDER_ENV_KEY_INDEX.get(name)
		if (!keys) continue
		for (const k of keys) set.add(k)
	}
	return Array.from(set).sort()
}

interface SnapshotAggregates {
	skillCount: number
	invalidSkillCount: number
	triggerCount: number
	activeProviders: string[]
}

/**
 * Fetch the per-actor aggregates + workspace-scoped active integrations
 * needed to build a capability snapshot for a single agent. Uses the
 * workspace_members join to find every workspace the agent belongs to and
 * takes the union of active providers across them — an agent's runtime env
 * is materialised from whichever workspace launches the session.
 */
async function fetchSnapshotAggregates(db: Database, actorId: string): Promise<SnapshotAggregates> {
	const [skillRows, triggerRows, integrationRows] = await Promise.all([
		db
			.select({ isValid: workspaceSkills.isValid })
			.from(agentSkills)
			.innerJoin(workspaceSkills, eq(agentSkills.workspaceSkillId, workspaceSkills.id))
			.where(eq(agentSkills.actorId, actorId)),
		db.select({ value: count() }).from(triggers).where(eq(triggers.targetActorId, actorId)),
		db
			.selectDistinct({ provider: integrations.provider })
			.from(integrations)
			.innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, integrations.workspaceId))
			.where(and(eq(workspaceMembers.actorId, actorId), eq(integrations.status, 'active'))),
	])

	let invalidSkillCount = 0
	for (const row of skillRows) {
		if (row.isValid === false) invalidSkillCount += 1
	}
	return {
		skillCount: skillRows.length,
		invalidSkillCount,
		triggerCount: Number(triggerRows[0]?.value ?? 0),
		activeProviders: integrationRows.map((r) => r.provider),
	}
}

/**
 * Build a full capability snapshot for one agent actor. Returns null when
 * the actor is not an agent — humans don't carry a capability card.
 */
export async function buildActorCapability(
	db: Database,
	actor: ActorRowForSnapshot,
): Promise<AgentCapability | null> {
	if (actor.type !== 'agent') return null
	const aggregates = await fetchSnapshotAggregates(db, actor.id)
	const snapshot: AgentCapabilitySnapshot = {
		systemPrompt: actor.systemPrompt,
		description: actor.description,
		mcpServers: extractMcpServers(actor.tools),
		skillCount: aggregates.skillCount,
		invalidSkillCount: aggregates.invalidSkillCount,
		triggerCount: aggregates.triggerCount,
		inLoop: extractInLoop(actor.metadata),
		model: extractModel(actor.llmConfig),
		llmProvider: actor.llmProvider,
		memoryKeys: extractMemoryKeys(actor.memory),
		activeIntegrationProviders: aggregates.activeProviders,
		availableEnvKeys: buildAvailableEnvKeys(aggregates.activeProviders),
	}
	return scoreAgentCapability(snapshot)
}

interface ActorRowForList {
	id: string
	type: string
}

/**
 * Batched flavour for the list endpoint. Pulls per-actor aggregates for the
 * whole page of agents in a bounded number of queries, then computes the
 * compact capability shape (level + score + topGap count). Actors that
 * aren't agents map to `null`.
 */
export async function buildActorCapabilitiesForList(
	db: Database,
	rows: readonly (ActorRowForList & {
		systemPrompt?: string | null
		description?: string | null
		tools?: unknown
		memory?: unknown
		llmProvider?: string | null
		llmConfig?: unknown
		metadata?: unknown
	})[],
	options: { workspaceScope?: 'membership' | 'workspace'; workspaceId?: string } = {},
): Promise<Map<string, CapabilityCompact | null>> {
	const result = new Map<string, CapabilityCompact | null>()
	const agentIds: string[] = []
	for (const row of rows) {
		if (row.type === 'agent') agentIds.push(row.id)
		else result.set(row.id, null)
	}
	if (agentIds.length === 0) return result

	// Agent rows only carry list-endpoint columns (no systemPrompt/tools/etc.)
	// so we re-fetch the columns the scorer needs in one shot instead of
	// widening the list query for every caller.
	const actorRows = await db
		.select({
			id: actors.id,
			type: actors.type,
			systemPrompt: actors.systemPrompt,
			description: actors.description,
			tools: actors.tools,
			memory: actors.memory,
			llmProvider: actors.llmProvider,
			llmConfig: actors.llmConfig,
			metadata: actors.metadata,
		})
		.from(actors)
		.where(inArray(actors.id, agentIds))

	// Aggregates fan out one query per aggregation, grouped by actor id.
	const [skillRows, triggerRows, integrationRows] = await Promise.all([
		db
			.select({
				actorId: agentSkills.actorId,
				isValid: workspaceSkills.isValid,
			})
			.from(agentSkills)
			.innerJoin(workspaceSkills, eq(agentSkills.workspaceSkillId, workspaceSkills.id))
			.where(inArray(agentSkills.actorId, agentIds)),
		db
			.select({ actorId: triggers.targetActorId, value: count() })
			.from(triggers)
			.where(inArray(triggers.targetActorId, agentIds))
			.groupBy(triggers.targetActorId),
		buildActiveProvidersForActors(db, agentIds, options),
	])

	const skillCounts = new Map<string, { count: number; invalid: number }>()
	for (const row of skillRows) {
		const entry = skillCounts.get(row.actorId) ?? { count: 0, invalid: 0 }
		entry.count += 1
		if (row.isValid === false) entry.invalid += 1
		skillCounts.set(row.actorId, entry)
	}
	const triggerCounts = new Map<string, number>()
	for (const row of triggerRows) {
		triggerCounts.set(row.actorId, Number(row.value))
	}

	for (const actor of actorRows) {
		const skillEntry = skillCounts.get(actor.id) ?? { count: 0, invalid: 0 }
		const providers = integrationRows.get(actor.id) ?? []
		const snapshot: AgentCapabilitySnapshot = {
			systemPrompt: actor.systemPrompt,
			description: actor.description,
			mcpServers: extractMcpServers(actor.tools),
			skillCount: skillEntry.count,
			invalidSkillCount: skillEntry.invalid,
			triggerCount: triggerCounts.get(actor.id) ?? 0,
			inLoop: extractInLoop(actor.metadata),
			model: extractModel(actor.llmConfig),
			llmProvider: actor.llmProvider,
			memoryKeys: extractMemoryKeys(actor.memory),
			activeIntegrationProviders: providers,
			availableEnvKeys: buildAvailableEnvKeys(providers),
		}
		const capability = scoreAgentCapability(snapshot)
		result.set(actor.id, {
			level: capability.overall.level,
			score: capability.overall.score,
			topGapCount: capability.topGaps.length,
		})
	}
	return result
}

/**
 * Resolve the set of active integration providers each agent has access to.
 * Two modes:
 *  - `workspace`: caller passes a single workspace id; every agent in the
 *    list shares that workspace's active providers (workspace-scoped
 *    listing branch).
 *  - `membership` (default): join through `workspace_members` per actor and
 *    union the active providers across every workspace the actor belongs to
 *    (cross-workspace listing branch).
 */
async function buildActiveProvidersForActors(
	db: Database,
	actorIds: string[],
	options: { workspaceScope?: 'membership' | 'workspace'; workspaceId?: string },
): Promise<Map<string, string[]>> {
	if (actorIds.length === 0) return new Map()

	if (options.workspaceScope === 'workspace' && options.workspaceId) {
		const rows = await db
			.selectDistinct({ provider: integrations.provider })
			.from(integrations)
			.where(
				and(eq(integrations.workspaceId, options.workspaceId), eq(integrations.status, 'active')),
			)
		const providers = rows.map((r) => r.provider)
		const map = new Map<string, string[]>()
		for (const id of actorIds) map.set(id, providers)
		return map
	}

	const rows = await db
		.select({
			actorId: workspaceMembers.actorId,
			provider: integrations.provider,
		})
		.from(workspaceMembers)
		.innerJoin(integrations, eq(integrations.workspaceId, workspaceMembers.workspaceId))
		.where(and(inArray(workspaceMembers.actorId, actorIds), eq(integrations.status, 'active')))
	const map = new Map<string, Set<string>>()
	for (const row of rows) {
		const set = map.get(row.actorId) ?? new Set<string>()
		set.add(row.provider)
		map.set(row.actorId, set)
	}
	const result = new Map<string, string[]>()
	for (const id of actorIds) {
		result.set(id, Array.from(map.get(id) ?? new Set()))
	}
	return result
}
