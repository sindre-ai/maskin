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

/**
 * Providers with an irreversible action that always waits for a person's approval, even at
 * `read_write`. Gmail: sending an email, approved on a For You approval card or on the draft.
 * Adding a provider here is a promise that its tool refuses the action until a person has
 * approved it and says how to ask.
 */
export const APPROVAL_GATED_PROVIDERS: ReadonlySet<string> = new Set(['gmail'])

export const requiresApprovalToAct = (provider: string): boolean =>
	APPROVAL_GATED_PROVIDERS.has(provider)
