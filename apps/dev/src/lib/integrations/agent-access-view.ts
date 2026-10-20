import type { Database } from '@maskin/db'
import { providerLabel } from './access-preamble'
import { attachesServer, listAgentAccess } from './agent-access'
import { getProvider } from './registry'

/**
 * What an agent can use, as one answer: for each connected integration its level and
 * whether its MCP server is attached, and for each saved credential whether the agent
 * has it. The agent page, the get_actor tool and the launch prompt all read this (or the
 * list under it), so a change made on the Integrations page, the Keychain page, in a chat
 * card or through a tool shows up the same everywhere.
 */
export interface AgentAccessView {
	integrations: Array<{
		integration_id: string
		provider: string
		name: string
		access: 'none' | 'read' | 'read_write'
		/** 'grant': this agent's own entry. 'default': the integration's default for agents. */
		source: 'grant' | 'default'
		default_access: 'read' | 'none'
		server_attached: boolean
		/** Who connected it; they and workspace admins may change access. */
		created_by: string
	}>
	credentials: Array<{
		integration_id: string
		name: string
		kind: 'api_key' | 'login'
		has_access: boolean
		/** 'always': a grant. 'this_chat': an Allow for the chat this is asked from. Else null. */
		scope: 'always' | 'this_chat' | null
		/** In how many chats it is shared with this agent, apart from any grant. */
		chat_count: number
		created_by: string
	}>
}

function hasServer(provider: string): boolean {
	try {
		const mcp = getProvider(provider)?.config.mcp
		// LinkedIn has one server per connected identity and no single spec, but it does attach.
		return !!mcp && (!!mcp.server || provider === 'linkedin-unipile')
	} catch {
		return false
	}
}

export async function describeAgentAccess(
	db: Database,
	workspaceId: string,
	actorId: string,
	/** The chat this is asked from, so an Allow for it counts. The agent page asks without one. */
	opts: { conversationId?: string | null } = {},
): Promise<AgentAccessView> {
	const rows = await listAgentAccess(db, workspaceId, actorId, opts)
	const view: AgentAccessView = { integrations: [], credentials: [] }
	for (const r of rows) {
		if (r.providerMode === 'registered') {
			view.integrations.push({
				integration_id: r.integrationId,
				provider: r.provider,
				name: providerLabel(r.provider),
				access: r.access,
				source: r.source === 'chat' ? 'grant' : r.source,
				default_access: r.defaultAgentAccess,
				server_attached: attachesServer(r, hasServer(r.provider)),
				created_by: r.createdBy,
			})
		} else if (r.providerMode === 'byo_apikey' || r.providerMode === 'byo_login') {
			if (!r.displayName) continue
			view.credentials.push({
				integration_id: r.integrationId,
				name: r.displayName,
				kind: r.providerMode === 'byo_login' ? 'login' : 'api_key',
				has_access: r.access !== 'none',
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
