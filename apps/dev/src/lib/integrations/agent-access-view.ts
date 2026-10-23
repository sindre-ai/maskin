import type { Database } from '@maskin/db'
import { type IntegrationDefaultAccess, actors } from '@maskin/db/schema'
import { inArray } from 'drizzle-orm'
import { providerLabel } from './access-preamble'
import { attachesServer, listAgentAccess } from './agent-access'
import { CUSTOM_MCP_PROVIDER } from './custom-mcp'
import { getProvider } from './registry'

/**
 * What an agent can use, as one answer: for each connected integration its level and
 * whether its MCP server is attached, and for each saved credential whether the agent
 * has it. The agent page, the get_actor tool and the launch prompt all read this (or the
 * list under it), so a change made on the Integrations page, the Keychain page, in a chat
 * card or through a tool shows up the same everywhere.
 */
export interface AgentAccessView {
	/**
	 * The Maskin MCP server: on every agent, read & write, and not something anyone can
	 * change. Reported so every screen can show it the same way instead of each knowing it.
	 */
	maskin_mcp: { name: string; access: 'read_write'; locked: true }
	integrations: Array<{
		integration_id: string
		provider: string
		name: string
		access: 'none' | 'read' | 'read_write'
		/** 'grant': this agent's own entry. 'default': the integration's default for agents. */
		source: 'grant' | 'default'
		default_access: IntegrationDefaultAccess
		server_attached: boolean
		/** Who connected it; they and workspace admins may change access. */
		created_by: string
		/** 'tool_server': a custom MCP server, on or off for the agent (no read-only level). */
		kind: 'integration' | 'tool_server'
		/** Tool server only: Maskin sits in front of it, so it has Read / Read & write / No access. */
		gated: boolean
	}>
	credentials: Array<{
		integration_id: string
		name: string
		kind: 'api_key' | 'login'
		has_access: boolean
		/** What an agent without its own entry gets: 'read' is every agent (Full access), 'none' is off. */
		default_access: 'read' | 'none'
		/** 'always': a grant. 'this_chat': an Allow for the chat this is asked from. Else null. */
		scope: 'always' | 'this_chat' | null
		/** In how many chats it is shared with this agent, apart from any grant. */
		chat_count: number
		created_by: string
	}>
}

function hasServer(provider: string): boolean {
	if (provider === CUSTOM_MCP_PROVIDER) return true
	try {
		const mcp = getProvider(provider)?.config.mcp
		// LinkedIn has one server per connected identity and no single spec, but it does attach.
		return !!mcp && (!!mcp.server || provider === 'linkedin-unipile')
	} catch {
		return false
	}
}

/** Display names of the members behind these actor ids, for labelling per-member connections. */
async function memberNames(db: Database, ids: string[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids)]
	if (unique.length === 0) return new Map()
	const found = await db
		.select({ id: actors.id, name: actors.name })
		.from(actors)
		.where(inArray(actors.id, unique))
	return new Map(found.map((a) => [a.id, a.name]))
}

export async function describeAgentAccess(
	db: Database,
	workspaceId: string,
	actorId: string,
	/** The chat this is asked from, so an Allow for it counts. The agent page asks without one. */
	opts: { conversationId?: string | null } = {},
): Promise<AgentAccessView> {
	const rows = await listAgentAccess(db, workspaceId, actorId, opts)
	const view: AgentAccessView = {
		maskin_mcp: { name: 'Maskin', access: 'read_write', locked: true },
		integrations: [],
		credentials: [],
	}
	// A provider connected more than once (two GitHub orgs) would show the same name twice, so
	// each of its rows says which account it is: "GitHub (sindre-ai)".
	const perProvider = new Map<string, number>()
	for (const r of rows) {
		if (r.providerMode === 'registered') {
			perProvider.set(r.provider, (perProvider.get(r.provider) ?? 0) + 1)
		}
	}
	const linkedInOwners = await memberNames(
		db,
		rows.filter((r) => r.provider === 'linkedin-unipile').map((r) => r.createdBy),
	)
	const accountOf = (r: (typeof rows)[number]): string | null =>
		r.provider === 'linkedin-unipile'
			? (linkedInOwners.get(r.createdBy) ?? null)
			: (r.accountLabel ?? null)

	for (const r of rows) {
		if (r.providerMode === 'registered') {
			const account = (perProvider.get(r.provider) ?? 0) > 1 ? accountOf(r) : null
			view.integrations.push({
				integration_id: r.integrationId,
				provider: r.provider,
				name:
					r.provider === CUSTOM_MCP_PROVIDER
						? (r.displayName ?? 'Tool server')
						: account
							? `${providerLabel(r.provider)} (${account})`
							: providerLabel(r.provider),
				access: r.access,
				source: r.source === 'chat' ? 'grant' : r.source,
				default_access: r.defaultAgentAccess,
				server_attached: attachesServer(r, hasServer(r.provider)),
				created_by: r.createdBy,
				kind: r.provider === CUSTOM_MCP_PROVIDER ? 'tool_server' : 'integration',
				gated: r.provider === CUSTOM_MCP_PROVIDER && r.gated,
			})
		} else if (r.providerMode === 'byo_apikey' || r.providerMode === 'byo_login') {
			if (!r.displayName) continue
			view.credentials.push({
				integration_id: r.integrationId,
				name: r.displayName,
				kind: r.providerMode === 'byo_login' ? 'login' : 'api_key',
				has_access: r.access !== 'none',
				// A saved key has no read/write level: only a 'read' default is on for agents.
				default_access: r.defaultAgentAccess === 'read' ? 'read' : 'none',
				scope:
					r.access === 'none'
						? null
						: r.source === 'chat'
							? ('this_chat' as const)
							: ('always' as const),
				chat_count: r.chatCount,
				created_by: r.createdBy,
			})
		}
	}
	return view
}
