// Tool-name aliases: old tool names that stay LISTED in tools/list, each a real
// registration whose handler maps its arguments onto the tool it points to.
// Listed, not hidden, because an LLM client can only call tools it sees; a
// hidden alias would never rescue a stored prompt.
//
// Each listed alias costs roughly 60 to 100 tokens in every tool list, so the
// number is capped. Removal is a ledger decision with a sweep date, never a
// zero count alone (tech spec, section 3.1).
export const TOOL_NAME_ALIASES = {
	// Removed from the surface in PR 1986 (12 Oct 2026). 55 triggers and 143
	// agent system prompts in 31 other workspaces still told agents to call it,
	// and those cannot be swept. Earliest removal: late January 2027.
	run_agent: 'create_session',
} as const satisfies Record<string, string>

export type ToolNameAlias = keyof typeof TOOL_NAME_ALIASES

export const MAX_LISTED_TOOL_ALIASES = 10

// Keys the old run_agent took that create_session has no equivalent for. They
// are dropped, and their names (never values) go into the alias_use event so we
// can see who relied on them.
export const RUN_AGENT_DROPPED_KEYS = [
	'config',
	'poll_interval_seconds',
	'timeout_seconds',
	'depends_on_session_ids',
] as const
