/**
 * What an agent may do with an integration. One vocabulary for every place that says it:
 * the Integrations, Keychain and agent pages, the launch prompt, and the tool messages.
 * There is no write-only level: an agent that may change something may also look at it.
 *
 * `read_write` is the risky level, which is why agents only get `read` by default. Where an
 * action cannot be undone (sending an email through Gmail) `read_write` does not mean "no
 * questions asked": the tool still waits for a person's approval of that one action.
 */
export type AgentAccessLevel = 'none' | 'read' | 'read_write'

export const AGENT_ACCESS_LABELS: Record<AgentAccessLevel, string> = {
	none: 'No access',
	read: 'Read',
	read_write: 'Read & write',
}

/** What the level means for the agent's tools, in one short clause. */
export const AGENT_ACCESS_EFFECT: Record<AgentAccessLevel, string> = {
	none: 'no tools',
	read: 'read tools only; write tools are refused',
	read_write: 'all tools',
}
