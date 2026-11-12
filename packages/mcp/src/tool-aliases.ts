// Tool-name aliases: old tool names that stay LISTED in tools/list, each a real
// registration whose handler maps its arguments onto the tool it points to.
// Listed, not hidden, because an LLM client can only call tools it sees; a
// hidden alias would never rescue a stored prompt.
//
// Each listed alias costs roughly 60 to 100 tokens in every tool list, so the
// number is capped. Removal is a ledger decision with a sweep date, never a
// zero count alone (tech spec, section 3.1).
export const TOOL_NAME_ALIASES = {
	// Folded into list_objects by the list contract (wave 2, T3): list_objects now takes q and
	// pages a ranked search behind its one cursor. The name stays because stored prompts and older
	// agents still call it, and every call forwards to the list_objects handler. Earliest removal:
	// 2027-02-01, and not before a clean stored-prompt sweep.
	search_objects: 'list_objects',
} as const satisfies Record<string, string>

export type ToolNameAlias = keyof typeof TOOL_NAME_ALIASES

export const MAX_LISTED_TOOL_ALIASES = 10

// The argument names a tool-name alias maps onto its target. The handler maps them and the
// alias_use event reports them (names only, never values). `query` is also an alias row on the
// tool itself (aliases.ts), listed here so one event carries the whole mapping.
export const TOOL_ALIAS_ARG_RENAMES: Partial<Record<ToolNameAlias, Record<string, string>>> = {
	search_objects: { query: 'q', driver_id: 'driver', offset: 'cursor' },
}
