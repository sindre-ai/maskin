/**
 * What an agent may do with an integration. One vocabulary for every place that says it:
 * the Integrations, Keychain and agent pages, the launch prompt, and the tool messages.
 */
export type AgentAccessLevel = 'none' | 'read' | 'write' | 'read_write'

export const AGENT_ACCESS_LABELS: Record<AgentAccessLevel, string> = {
	none: 'No access',
	read: 'Read',
	write: 'Write',
	read_write: 'Read & write',
}

/** What the level means for the agent's tools, in one short clause. */
export const AGENT_ACCESS_EFFECT: Record<AgentAccessLevel, string> = {
	none: 'no tools',
	read: 'read tools only; write tools are refused',
	write: 'write tools only; read tools are refused',
	read_write: 'all tools',
}
