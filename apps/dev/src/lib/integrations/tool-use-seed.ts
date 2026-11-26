import type { Database } from '@maskin/db'
import {
	actors,
	agentGrants,
	integrations,
	sessionLogs,
	sessions,
	triggers,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { attachesServer, effectiveAccess } from './agent-access'
import { CUSTOM_MCP_PROVIDER, customServerKey } from './custom-mcp'

/**
 * Seeds an agent grant for each outside tool server an agent really uses, so that switching an
 * integration's default agent access to none later takes away nothing in use. It only adds
 * grants, at the level the agent has today (its own, else the integration's default), so a
 * session attaches the same tools before and after. It never lowers or replaces a grant.
 *
 * Use is the union of: session logs (tool calls name their server), the agent's own tool config
 * and instructions, triggers and flow steps (a flow step is a trigger), the merge tools, and an
 * optional list from the integration tool event. Maskin's own server is not seeded here.
 */

export const DEFAULT_USAGE_DAYS = 30

export type UsageSource = 'session_logs' | 'agent_config' | 'trigger' | 'merge_tools' | 'event'

/** Server key from a Claude Code tool name: mcp__<server>__<tool>. Null for anything else. */
export function serverOfToolName(toolName: string): string | null {
	const m = /^mcp__(.+?)__[^_]/.exec(toolName)
	return m?.[1] ?? null
}

/** Server keys named in free text: tool names, and the keys the launch spec gives servers. */
export function serverKeysInText(text: string): Set<string> {
	const keys = new Set<string>()
	for (const m of text.matchAll(/mcp__([A-Za-z0-9-]+?(?:_[A-Za-z0-9-]+)*?)__[A-Za-z0-9_-]+/g)) {
		if (m[1]) keys.add(m[1])
	}
	for (const m of text.matchAll(
		/\b((?:integration|github|linkedin)-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g,
	)) {
		if (m[1]) keys.add(m[1])
	}
	return keys
}

/** The merge tools: an agent that merges needs the GitHub server even if it merged nothing lately. */
export function namesMergeTool(text: string): boolean {
	return /\bmerge_pull_request\b|\bupdate_pull_request_branch\b/.test(text)
}

type IntegrationRow = Pick<
	typeof integrations.$inferSelect,
	'id' | 'provider' | 'providerMode' | 'status' | 'config' | 'defaultAgentAccess' | 'displayName'
>

/** Integrations whose server a key stands for. Empty when the key is not an outside tool server. */
export function integrationsForServerKey(
	serverKey: string,
	rows: IntegrationRow[],
): IntegrationRow[] {
	const registered = rows.filter((r) => r.providerMode === 'registered' && r.status === 'active')
	if (serverKey.startsWith('integration-')) {
		const provider = serverKey.slice('integration-'.length)
		return registered.filter((r) => r.provider === provider)
	}
	if (serverKey === 'github' || serverKey.startsWith('github-')) {
		const owner = serverKey === 'github' ? null : serverKey.slice('github-'.length)
		return registered.filter(
			(r) =>
				r.provider === 'github' &&
				(owner === null ||
					((r.config as { owner_login?: string } | null)?.owner_login ?? '').toLowerCase() ===
						owner),
		)
	}
	if (serverKey.startsWith('linkedin-')) {
		return registered.filter((r) => r.provider === 'linkedin-unipile')
	}
	// A custom tool server is one row, keyed by its name and the start of its id.
	if (serverKey.startsWith('custom-')) {
		return registered.filter(
			(r) => r.provider === CUSTOM_MCP_PROVIDER && customServerKey(r) === serverKey,
		)
	}
	// Older sessions name a server by its provider alone: slack, gmail, posthog.
	return registered.filter((r) => r.provider === serverKey)
}

export type UsageMap = Map<string, Map<string, Set<UsageSource>>>

function addUsage(usage: UsageMap, actorId: string, key: string, source: UsageSource) {
	const byKey = usage.get(actorId) ?? new Map<string, Set<UsageSource>>()
	const sources = byKey.get(key) ?? new Set<UsageSource>()
	sources.add(source)
	byKey.set(key, sources)
	usage.set(actorId, byKey)
}

/** Sessions per log query, so each query stays well inside the database's time limit. */
const LOG_SESSION_BATCH = 50

/**
 * Servers each agent called in the last `days` days, read from the session logs. The logs are
 * read for a few sessions at a time through the session index: one query over the whole
 * window times out on production (45 second limit).
 */
async function readLogUsage(
	db: Database,
	usage: UsageMap,
	opts: { workspaceId?: string; days: number },
) {
	const since = sql`now() - make_interval(days => ${opts.days}::int)`
	const recent = await db
		.select({ id: sessions.id, actorId: sessions.actorId })
		.from(sessions)
		.where(
			and(
				gt(sessions.updatedAt, since),
				opts.workspaceId ? eq(sessions.workspaceId, opts.workspaceId) : undefined,
			),
		)
	const actorOf = new Map(recent.map((s) => [s.id, s.actorId]))
	const ids = [...actorOf.keys()]
	for (let i = 0; i < ids.length; i += LOG_SESSION_BATCH) {
		const batch = ids.slice(i, i + LOG_SESSION_BATCH)
		const rows = await db.execute<{ session_id: string; server: string }>(sql`
			SELECT DISTINCT session_logs.session_id AS session_id, m.parts[1] AS server
			FROM session_logs
			CROSS JOIN LATERAL regexp_matches(
				session_logs.content, '"name":"mcp__([^"]+?)__[^"]+"', 'g'
			) AS m(parts)
			WHERE session_logs.stream = 'stdout'
				AND session_logs.created_at > ${since}
				AND session_logs.content LIKE '%"name":"mcp__%'
				AND ${inArray(sessionLogs.sessionId, batch)}
		`)
		for (const r of rows) {
			const actorId = actorOf.get(r.session_id)
			if (actorId) addUsage(usage, actorId, r.server, 'session_logs')
		}
	}
}

export interface SeedOptions {
	workspaceId?: string
	days?: number
	dryRun?: boolean
	/** Providers per actor from the integration tool event, read elsewhere: { actorId: ['gmail'] }. */
	eventUsage?: Record<string, string[]>
}

export interface AgentSeedReport {
	workspaceId: string
	actorId: string
	name: string
	/** Providers or installs attached to a session today. */
	attachedToday: string[]
	/** The same list once defaults are none: what its grants keep. */
	attachedAfterDefaultsNone: string[]
	grantsAdded: string[]
	/** Servers named in use that are not outside tool servers seeded here (Maskin's own, extensions). */
	skippedServers: string[]
}

const label = (r: IntegrationRow) => {
	const owner = (r.config as { owner_login?: string } | null)?.owner_login
	return owner ? `${r.provider}:${owner}` : r.provider
}

export async function seedToolGrants(
	db: Database,
	opts: SeedOptions = {},
): Promise<AgentSeedReport[]> {
	const days = opts.days ?? DEFAULT_USAGE_DAYS
	const usage: UsageMap = new Map()
	await readLogUsage(db, usage, { workspaceId: opts.workspaceId, days })

	const wsRows = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(opts.workspaceId ? eq(workspaces.id, opts.workspaceId) : undefined)

	const reports: AgentSeedReport[] = []
	for (const ws of wsRows) {
		const agents = await db
			.select({
				id: actors.id,
				name: actors.name,
				tools: actors.tools,
				systemPrompt: actors.systemPrompt,
			})
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, ws.id), eq(actors.type, 'agent')))
		if (agents.length === 0) continue
		const agentIds = agents.map((a) => a.id)

		const intRows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		const grantRows = await db
			.select()
			.from(agentGrants)
			.where(and(eq(agentGrants.workspaceId, ws.id), inArray(agentGrants.actorId, agentIds)))
		const triggerRows = await db
			.select({
				targetActorId: triggers.targetActorId,
				actionPrompt: triggers.actionPrompt,
				config: triggers.config,
			})
			.from(triggers)
			.where(eq(triggers.workspaceId, ws.id))

		// Config, instructions, triggers and flow steps (a flow step is a trigger).
		for (const a of agents) {
			const text = `${JSON.stringify(a.tools ?? {})}\n${a.systemPrompt ?? ''}`
			for (const k of serverKeysInText(text)) addUsage(usage, a.id, k, 'agent_config')
			if (namesMergeTool(text)) addUsage(usage, a.id, 'github', 'merge_tools')
		}
		for (const t of triggerRows) {
			const text = `${t.actionPrompt}\n${JSON.stringify(t.config ?? {})}`
			for (const k of serverKeysInText(text)) addUsage(usage, t.targetActorId, k, 'trigger')
			if (namesMergeTool(text)) addUsage(usage, t.targetActorId, 'github', 'merge_tools')
		}
		for (const [actorId, providers] of Object.entries(opts.eventUsage ?? {})) {
			for (const p of providers) addUsage(usage, actorId, `integration-${p}`, 'event')
		}

		const live = intRows.filter((r) => r.providerMode === 'registered' && r.status === 'active')
		for (const a of agents) {
			const own = new Map(
				grantRows.filter((g) => g.actorId === a.id).map((g) => [g.integrationId, g]),
			)
			const keys = [...(usage.get(a.id)?.keys() ?? [])]
			const toGrant = new Map<string, IntegrationRow>()
			const skipped: string[] = []
			for (const key of keys) {
				const matches = integrationsForServerKey(key, intRows)
				if (matches.length === 0) skipped.push(key)
				for (const m of matches) toGrant.set(m.id, m)
			}
			const added: IntegrationRow[] = []
			for (const m of toGrant.values()) {
				// Keep what the agent has: an existing grant stays, a default of none stays none.
				if (own.has(m.id) || m.defaultAgentAccess === 'none') continue
				added.push(m)
			}
			if (!opts.dryRun && added.length > 0) {
				await db
					.insert(agentGrants)
					.values(
						added.map((m) => ({
							workspaceId: ws.id,
							integrationId: m.id,
							actorId: a.id,
							access: m.defaultAgentAccess,
						})),
					)
					.onConflictDoNothing({ target: [agentGrants.integrationId, agentGrants.actorId] })
			}
			const accessOf = (r: IntegrationRow, withDefault: boolean) => {
				const g =
					own.get(r.id)?.access ?? added.find((x) => x.id === r.id)?.defaultAgentAccess ?? null
				return effectiveAccess(
					{
						providerMode: 'registered',
						defaultAgentAccess: withDefault ? r.defaultAgentAccess : 'none',
					},
					g,
				)
			}
			const attached = (withDefault: boolean) =>
				live
					.filter((r) =>
						attachesServer(
							{
								providerMode: 'registered',
								status: 'active',
								exposed: true,
								access: accessOf(r, withDefault),
							},
							true,
						),
					)
					.map(label)
					.sort()
			reports.push({
				workspaceId: ws.id,
				actorId: a.id,
				name: a.name,
				attachedToday: attached(true),
				attachedAfterDefaultsNone: attached(false),
				grantsAdded: added.map(label).sort(),
				skippedServers: skipped.sort(),
			})
		}
	}
	return reports
}
