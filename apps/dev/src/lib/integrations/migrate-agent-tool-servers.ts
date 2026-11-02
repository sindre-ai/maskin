import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { actors, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { encrypt } from '../crypto'
import { recordEvent } from '../events/record-event'
import { logger } from '../logger'
import { isMaskinMcpEntry } from '../mcp-session-header'
import { upsertAgentGrant } from './agent-grants'
import {
	CUSTOM_MCP_PROVIDER,
	type CustomMcpServer,
	customMcpServerSchema,
	summarizeServer,
} from './custom-mcp'
import { listProviders } from './registry'

/**
 * Moves the MCP servers people added by hand to individual agents (an agent's
 * `tools.mcpServers`) up to the workspace, where the Integrations page manages them and
 * grants decide which agents get them. The same server on several agents becomes one row
 * with a grant per agent. Run once at startup; it is idempotent, because an entry is removed
 * from the agent as soon as it has been moved.
 *
 * Left where they are, because something else already attaches or depends on them:
 * - the Maskin MCP server, which every agent now gets anyway;
 * - servers that belong to a connected integration (the ones this API hosts under
 *   /api/integrations/..., a provider's own hosted MCP URL, GitHub), which grants attach;
 * - anything that does not validate as a server.
 */

const ADVISORY_LOCK_KEY = 'maskin:migrate-agent-tool-servers'

function providerServerUrls(): string[] {
	const urls: string[] = []
	for (const p of listProviders()) {
		const url = (p.config.mcp?.server as { url?: unknown } | undefined)?.url
		if (typeof url === 'string' && !url.startsWith('$')) urls.push(url)
	}
	return urls
}

/** True for a server that is the tool side of a connected integration, not a free-standing one. */
export function belongsToAnIntegration(
	name: string,
	spec: Record<string, unknown>,
	providerUrls: string[] = providerServerUrls(),
): boolean {
	const entry: unknown = { ...spec }
	if (isMaskinMcpEntry(entry)) return true
	if (/^(github|integration-)/i.test(name)) return true
	const url = typeof spec.url === 'string' ? spec.url : ''
	if (url.includes('/api/integrations/')) return true
	if (url && providerUrls.some((u) => url.startsWith(u))) return true
	const text = JSON.stringify(spec)
	return text.includes('server-github') || text.includes('${GITHUB_')
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a.localeCompare(b),
		)
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
	}
	return JSON.stringify(value)
}

interface Found {
	agentId: string
	agentName: string
	name: string
	server: CustomMcpServer
}

export async function migrateAgentToolServers(
	db: Database,
): Promise<{ servers: number; agents: number }> {
	const memberships = await db
		.selectDistinct({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(actors.type, 'agent'),
				sql`jsonb_typeof(${actors.tools} -> 'mcpServers') = 'object'`,
				sql`${actors.tools} -> 'mcpServers' <> '{}'::jsonb`,
			),
		)

	let servers = 0
	let agents = 0
	const providerUrls = providerServerUrls()
	for (const { workspaceId } of memberships) {
		try {
			const moved = await db.transaction(async (tx) => {
				const [lock] = await tx.execute<{ locked: boolean }>(
					sql`SELECT pg_try_advisory_xact_lock(hashtext(${ADVISORY_LOCK_KEY}), hashtext(${workspaceId})) AS locked`,
				)
				if (!lock?.locked) return null

				const agentRows = await tx
					.select({ id: actors.id, name: actors.name, tools: actors.tools })
					.from(actors)
					.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
					.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'agent')))
					.for('update', { of: actors })

				const found: Found[] = []
				const leftByAgent = new Map<string, Record<string, unknown>>()
				for (const agent of agentRows) {
					const tools = (agent.tools ?? {}) as Record<string, unknown>
					const map = tools.mcpServers
					if (!map || typeof map !== 'object' || Array.isArray(map)) continue
					const kept: Record<string, unknown> = {}
					let changed = false
					for (const [name, spec] of Object.entries(map as Record<string, unknown>)) {
						const parsed =
							spec && typeof spec === 'object'
								? customMcpServerSchema.safeParse(spec)
								: { success: false as const }
						if (
							!parsed.success ||
							belongsToAnIntegration(name, spec as Record<string, unknown>, providerUrls)
						) {
							kept[name] = spec
							continue
						}
						found.push({ agentId: agent.id, agentName: agent.name, name, server: parsed.data })
						changed = true
					}
					if (changed) leftByAgent.set(agent.id, { ...tools, mcpServers: kept })
				}
				if (found.length === 0) return { servers: 0, agents: 0 }

				// Who the new rows belong to: the workspace's first owner, so a person can manage them.
				const [owner] = await tx
					.select({ actorId: workspaceMembers.actorId })
					.from(workspaceMembers)
					.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
					.where(
						and(
							eq(workspaceMembers.workspaceId, workspaceId),
							eq(workspaceMembers.role, 'owner'),
							eq(actors.type, 'human'),
						),
					)
					.orderBy(asc(workspaceMembers.joinedAt))
					.limit(1)

				const existing = await tx
					.select({ displayName: integrations.displayName })
					.from(integrations)
					.where(
						and(
							eq(integrations.workspaceId, workspaceId),
							eq(integrations.provider, CUSTOM_MCP_PROVIDER),
							eq(integrations.status, 'active'),
						),
					)
				const taken = new Set(existing.map((r) => (r.displayName ?? '').toLowerCase()))

				// One row per distinct (name, definition); the same server on many agents is one row.
				const groups = new Map<string, { name: string; server: CustomMcpServer; agents: Found[] }>()
				for (const f of found) {
					const key = `${f.name}\u0000${stable(f.server)}`
					const group = groups.get(key)
					if (group) group.agents.push(f)
					else groups.set(key, { name: f.name, server: f.server, agents: [f] })
				}

				for (const group of groups.values()) {
					// Two different servers under one name: tell them apart by the first agent's name.
					let name = group.name.slice(0, 60)
					if (taken.has(name.toLowerCase())) {
						name = `${group.name} (${group.agents[0]?.agentName ?? 'agent'})`.slice(0, 60)
					}
					for (let n = 2; taken.has(name.toLowerCase()); n++) {
						name = `${group.name} ${n}`.slice(0, 60)
					}
					taken.add(name.toLowerCase())

					const createdBy = owner?.actorId ?? group.agents[0]?.agentId
					if (!createdBy) continue
					const id = randomUUID()
					const [row] = await tx
						.insert(integrations)
						.values({
							id,
							externalId: id,
							workspaceId,
							provider: CUSTOM_MCP_PROVIDER,
							status: 'active',
							credentials: encrypt(JSON.stringify({ server: group.server })),
							config: { custom_mcp: summarizeServer(group.server) },
							displayName: name,
							defaultAgentAccess: 'none',
							createdBy,
						})
						.returning({ id: integrations.id })
					if (!row) continue
					for (const f of group.agents) {
						await upsertAgentGrant(tx, {
							workspaceId,
							integrationId: row.id,
							actorId: f.agentId,
							access: 'read_write',
							createdBy,
						})
					}
					await recordEvent(tx, {
						workspaceId,
						actorId: createdBy,
						action: 'created',
						entityType: 'integration',
						entityId: row.id,
						data: {
							provider: CUSTOM_MCP_PROVIDER,
							name,
							change: 'moved_from_agents',
							agent_ids: group.agents.map((f) => f.agentId),
						},
					})
				}

				// Only now take the servers off the agents, in the same transaction.
				for (const [agentId, tools] of leftByAgent) {
					await tx.update(actors).set({ tools }).where(eq(actors.id, agentId))
				}
				return { servers: groups.size, agents: leftByAgent.size }
			})
			if (moved) {
				servers += moved.servers
				agents += moved.agents
			}
		} catch (err) {
			// One workspace failing must not stop the rest, or block startup.
			logger.error('Could not move agent tool servers to the workspace', {
				workspaceId,
				error: String(err),
			})
		}
	}
	return { servers, agents }
}
