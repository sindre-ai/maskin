import type { Database } from '@maskin/db'
import {
	INTEGRATION_STATUS_ACTIVE,
	actors,
	events,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { entryMatcherFor } from './mcp-entries'
import { listLinkedInIdentities } from './providers/linkedin-unipile/identities'
import { listProviders } from './registry'
import type { McpEntryOwner, McpServerSpec, ProviderConfig } from './types'

/**
 * The MCP entries an agent can be given, derived from each provider's own
 * `config.ts` plus the workspace's live integrations and identities.
 *
 * One list serves every client. The web Quick Add buttons, the
 * `list_integration_mcp_presets` tool and the approve route all read it, so the
 * UI and agents cannot drift apart, and the approve route can re-derive the
 * entry server side instead of trusting whatever a click carried.
 *
 * `preset_id` is the key the entry is filed under in `tools.mcpServers`: the
 * provider name for a shared entry, the instance slug for a LinkedIn identity,
 * `github-<owner>` for a GitHub installation. Only ACTIVE integrations
 * produce a preset: a revoked credential offers nothing to attach.
 */

export interface McpPreset {
	preset_id: string
	provider: string
	provider_label: string
	/** What a person sees on the attach button. Never a provider id. */
	label: string
	/** The integration row this entry belongs to. */
	integration_id: string
	/** The key the entry is filed under in `actors.tools.mcpServers`. */
	key: string
	/** True when session-manager already wires this provider into every session. */
	auto_injected: boolean
	server: McpServerSpec
}

export interface ResolvedMcpPreset extends McpPreset {
	config: ProviderConfig
	owner: McpEntryOwner
}

/**
 * Providers whose per-identity entries come from a live source rather than the
 * integrations table. A contract test fails when a per-identity provider has no
 * enumerator here.
 */
export const IDENTITY_ENUMERATORS: Record<
	string,
	(
		db: Database,
		workspaceId: string,
	) => Promise<Array<{ instanceSlug: string; displayName: string; integrationId: string }>>
> = {
	'linkedin-unipile': listLinkedInIdentities,
}

type ActiveRow = McpEntryOwner & { id: string; provider: string }

async function activeRowsByProvider(db: Database, workspaceId: string) {
	const rows = await db
		.select({
			id: integrations.id,
			provider: integrations.provider,
			config: integrations.config,
			unipileAccSlug: integrations.unipileAccSlug,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
		.orderBy(integrations.createdAt)
	const byProvider = new Map<string, ActiveRow[]>()
	for (const row of rows) {
		byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row])
	}
	return byProvider
}

/** Every preset the workspace's active integrations can offer, with the data the approve route needs. */
export async function resolveMcpPresets(
	db: Database,
	workspaceId: string,
): Promise<ResolvedMcpPreset[]> {
	const byProvider = await activeRowsByProvider(db, workspaceId)
	const presets: ResolvedMcpPreset[] = []

	for (const { config } of listProviders()) {
		const mcp = config.mcp
		const active = byProvider.get(config.name) ?? []
		if (!mcp || active.length === 0) continue
		const base = {
			provider: config.name,
			provider_label: config.displayName,
			auto_injected: mcp.autoInject ?? false,
			config,
		}
		const decl = mcp.entry ?? { kind: 'shared' as const }

		if (decl.kind === 'shared') {
			if (!mcp.server) continue
			presets.push({
				...base,
				preset_id: config.name,
				key: config.name,
				label: config.displayName,
				integration_id: active[0].id,
				server: mcp.server,
				owner: active[0],
			})
		} else if (decl.kind === 'per-installation') {
			for (const row of active) {
				const key = decl.key(row)
				const server = decl.server(row)
				if (!key || !server) continue
				presets.push({
					...base,
					preset_id: key,
					key,
					label: `${config.displayName} ${decl.label(row) ?? key}`,
					integration_id: row.id,
					server,
					owner: row,
				})
			}
		} else {
			const identities = (await IDENTITY_ENUMERATORS[config.name]?.(db, workspaceId)) ?? []
			for (const identity of identities) {
				const owner = active.find((row) => row.id === identity.integrationId)
				// A registry entry whose row is no longer active is stale: the table is the truth.
				if (!owner) continue
				presets.push({
					...base,
					preset_id: identity.instanceSlug,
					key: identity.instanceSlug,
					label: identity.displayName,
					integration_id: owner.id,
					server: decl.server(identity.instanceSlug),
					owner,
				})
			}
		}
	}
	return presets
}

export function toPublicPreset({ config: _config, owner: _owner, ...preset }: ResolvedMcpPreset) {
	return preset satisfies McpPreset
}

type StoredServers = Record<string, unknown>

export function serversOf(tools: unknown): StoredServers {
	const servers = (tools as { mcpServers?: unknown } | null)?.mcpServers
	return servers && typeof servers === 'object' ? (servers as StoredServers) : {}
}

/** True when an entry points at what the preset would write, whatever key it is filed under. */
function sameTarget(entry: unknown, server: McpServerSpec): boolean {
	if (!entry || typeof entry !== 'object') return false
	const raw = entry as Record<string, unknown>
	if (server.type === 'http') {
		return (
			typeof raw.url === 'string' && raw.url.replace(/\/+$/, '') === server.url.replace(/\/+$/, '')
		)
	}
	return (
		raw.command === server.command &&
		JSON.stringify(raw.args ?? []) === JSON.stringify(server.args) &&
		JSON.stringify(raw.env ?? {}) === JSON.stringify(server.env ?? {})
	)
}

/** Whether the agent already holds this preset: under its key, or under another key pointing at the same place. */
export function presetAttached(preset: McpPreset, tools: unknown): boolean {
	const servers = serversOf(tools)
	if (servers[preset.key]) return true
	return Object.values(servers).some((entry) => sameTarget(entry, preset.server))
}

/**
 * Entries on an agent that point at a connection that is no longer active
 * (a revoked LinkedIn identity, a disconnected installation). The same
 * recognition disconnect uses, applied to the workspace's non-active rows, so
 * what is reported here is what disconnect would have removed.
 */
export async function staleEntriesOf(db: Database, workspaceId: string, tools: unknown) {
	const servers = serversOf(tools)
	if (Object.keys(servers).length === 0) return []
	const byProvider = await activeRowsByProvider(db, workspaceId)
	const dead = await db
		.select({
			id: integrations.id,
			provider: integrations.provider,
			config: integrations.config,
			unipileAccSlug: integrations.unipileAccSlug,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				ne(integrations.status, INTEGRATION_STATUS_ACTIVE),
				ne(integrations.status, 'pending'),
			),
		)

	const stale = new Map<string, { key: string; provider: string }>()
	for (const row of dead) {
		const provider = listProviders().find((p) => p.config.name === row.provider)
		if (!provider) continue
		const matches = entryMatcherFor(provider.config, row, byProvider.get(row.provider) ?? [])
		if (!matches) continue
		for (const [key, entry] of Object.entries(servers)) {
			if (matches(entry)) stale.set(key, { key, provider: row.provider })
		}
	}
	return [...stale.values()]
}

/**
 * Agents that lost this entry to a disconnect and do not hold it now. Read from
 * the audit trail `detachProviderMcpServers` writes, so it names exactly the
 * agents a disconnect stripped rather than every agent that happens not to
 * have the preset.
 */
export async function agentsThatLostPreset(
	db: Database,
	workspaceId: string,
	preset: McpPreset,
): Promise<Array<{ id: string; name: string }>> {
	const lost = await db
		.selectDistinct({ id: events.entityId })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityType, 'actor'),
				eq(events.action, 'updated'),
				sql`${events.data} -> 'mcp_servers_detached' @> ${JSON.stringify([preset.key])}::jsonb`,
			),
		)
	if (lost.length === 0) return []
	const agents = await db
		.select({ id: actors.id, name: actors.name, tools: actors.tools })
		.from(actors)
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.type, 'agent'),
				inArray(
					actors.id,
					lost.map((row) => row.id),
				),
			),
		)
	return agents
		.filter((agent) => !presetAttached(preset, agent.tools))
		.map(({ id, name }) => ({ id, name }))
}
