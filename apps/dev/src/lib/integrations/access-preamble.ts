import { AGENT_ACCESS_EFFECT, AGENT_ACCESS_LABELS, requiresApprovalToAct } from '@maskin/shared'
import type { ActorIntegrationAccess, AgentAccess } from './agent-access'
import { CUSTOM_MCP_PROVIDER } from './custom-mcp'
import { getProvider } from './registry'

const LEVEL_TEXT: Record<AgentAccess, string> = {
	read_write: `${AGENT_ACCESS_LABELS.read_write} (${AGENT_ACCESS_EFFECT.read_write})`,
	read: `${AGENT_ACCESS_LABELS.read} (${AGENT_ACCESS_EFFECT.read})`,
	none: AGENT_ACCESS_LABELS.none,
}

// Strongest first, so a mixed provider lists its best level first.
const LEVEL_ORDER: AgentAccess[] = ['read_write', 'read', 'none']

/** Read & write where an irreversible action still waits for a person (sending an email). */
const APPROVAL_GATED_WRITE = `${AGENT_ACCESS_LABELS.read_write} (all tools, but a person has to approve each email before you send it)`

export function providerLabel(provider: string): string {
	try {
		return getProvider(provider)?.config.displayName ?? provider
	} catch {
		return provider
	}
}

/**
 * The block of the system prompt that tells an agent what it may do with each connected
 * integration, so it does not have to find out by failing. Saved keys and logins are left
 * out: they are either in the environment or they are not. Empty when nothing is
 * connected, so a workspace with no integrations adds no text.
 */
export function buildAccessPreamble(
	rows: ActorIntegrationAccess[],
	{ personReachable = false }: { personReachable?: boolean } = {},
): string {
	const byProvider = new Map<string, Set<AgentAccess>>()
	for (const row of rows) {
		if (row.providerMode !== 'registered') continue
		// A custom tool server is simply there or not; it has no levels to explain.
		if (row.provider === CUSTOM_MCP_PROVIDER) continue
		const levels = byProvider.get(row.provider) ?? new Set<AgentAccess>()
		levels.add(row.access)
		byProvider.set(row.provider, levels)
	}
	if (byProvider.size === 0) return ''

	const lines = [...byProvider.entries()]
		.map(([provider, levels]) => ({ provider, label: providerLabel(provider), levels }))
		.sort((a, b) => a.label.localeCompare(b.label))
		.map(({ provider, label, levels }) => {
			const ordered = LEVEL_ORDER.filter((l) => levels.has(l)).map((l) =>
				l === 'read_write' && requiresApprovalToAct(provider)
					? APPROVAL_GATED_WRITE
					: LEVEL_TEXT[l],
			)
			const text =
				ordered.length === 1
					? ordered[0]
					: `${ordered.slice(0, -1).join(', ')} on some accounts and ${ordered[ordered.length - 1]} on others`
			return `- ${label}: ${text}`
		})

	return [
		'## Integration access',
		'A person sets what you may do with each connected integration. This is background for you: do not bring it up, and do not describe your access in an answer, unless it stops you doing something you were asked to do or someone asks about it. What you have:',
		...lines,
		personReachable
			? 'If a tool is refused because of access, do not retry or look for a workaround. Follow "When a tool or login is missing" below.'
			: 'If a tool is refused because of access, do not retry or look for a workaround. Say in your reply which integration and what level you need; a workspace admin can change it under Settings → Integrations.',
	]
		.join('\n')
		.concat('\n\n')
}

/**
 * What an agent does when it lacks a tool, an integration or a login, so it works down the
 * ways to get one instead of stopping at "I don't have X". Only for sessions with a person
 * reachable (a chat, or a helper started from one): the steps end in a card the person answers.
 */
export const MISSING_TOOL_BLOCK = `## When a tool or login is missing
If you are blocked because you lack a tool, integration or login, do not stop at "I don't have X". Work down this list and stop at the first step that gets you through:
1. Look first: list_integrations, list_keychain_credentials, list_integration_providers.
2. Needed once, and another agent already has the tool: ask that agent (create_session with wait, or an @mention). Do not ask the person first.
3. Needed again and again (even if this is the first time), or no agent has it: ask the person with a card. A saved credential you cannot use: request_keychain_access. No credential yet: request_keychain_credential. An integration not connected: connect_integration. An integration connected but not allowed for you: request_integration_access. A tool (MCP) server you know how to run or reach: add_mcp_server. You have a computer, so a login or key is usually enough for you to do the job.
4. Only if no card can be shown, say in your reply exactly what you need and where it is set.
After a card, end your turn; you are restarted when it is answered.

`
