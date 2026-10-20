/**
 * What an agent may do with an integration. One vocabulary for every place that says it:
 * the Integrations, Keychain and agent pages, the launch prompt, and the tool messages.
 * There is no write-only level: an agent that may change something may also look at it.
 *
 * `ask_first` sits between read and read & write, like "ask" in a coding agent's
 * permission modes: the agent may use the integration's tools, but an action that cannot
 * be undone waits for a person's yes. `read_write` is "always allow". Only a provider that
 * has such an action and a way to ask (see ASK_FIRST_PROVIDERS) offers it.
 */
export type AgentAccessLevel = 'none' | 'read' | 'ask_first' | 'read_write'

export const AGENT_ACCESS_LABELS: Record<AgentAccessLevel, string> = {
	none: 'No access',
	read: 'Read',
	ask_first: 'Ask first',
	read_write: 'Read & write',
}

/** What the level means for the agent's tools, in one short clause. */
export const AGENT_ACCESS_EFFECT: Record<AgentAccessLevel, string> = {
	none: 'no tools',
	read: 'read tools only; write tools are refused',
	ask_first: 'all tools, but sending needs a person to approve each one',
	read_write: 'all tools',
}

/**
 * Providers with an irreversible action that can wait for a person's approval, so they can
 * offer "Ask first". Gmail: sending an email, approved on a draft card. Adding a provider
 * here is a promise that its tool refuses the action at this level and says how to ask.
 */
export const ASK_FIRST_PROVIDERS: ReadonlySet<string> = new Set(['gmail'])

export const supportsAskFirst = (provider: string): boolean => ASK_FIRST_PROVIDERS.has(provider)
