// Names that were removed from the MCP surface on purpose.
//
// The surface guard (src/__tests__/surface-guard.test.ts) fails when a tool or
// parameter in the committed surface snapshot is missing from the live surface
// and is neither a live alias row (./aliases.ts) nor listed here. An entry needs
// a sweep date: the day by which stored prompts, triggers and skills that still
// name the old thing must have been swept. Removing a name without one is the
// mistake this guard exists to catch.

export interface RemovalEntry {
	tool: string
	/** Dotted parameter path. Leave out when the whole tool was removed. A path also covers its children. */
	path?: string
	/** Day the name left the surface, YYYY-MM-DD. */
	removed: string
	/** Day the stored-prompt sweep for this name is due or was done, YYYY-MM-DD. */
	sweepDate: string
	/** What was decided and why. */
	decision: string
}

export const REMOVAL_LEDGER: readonly RemovalEntry[] = [
	{
		tool: 'run_agent',
		removed: '2026-11-11',
		sweepDate: '2026-11-11',
		decision:
			'Deleted outright, with no alias. It was a listed alias of create_session (PR 1986, CTO decision D5). Use create_sub_chat, which always waits. Stored prompts and triggers in other workspaces that still name it now get an unknown-tool error and must be rewritten.',
	},
	{
		tool: 'create_session',
		removed: '2026-11-11',
		sweepDate: '2026-11-11',
		decision:
			'Deleted outright, with no alias. It was the same handler as create_sub_chat under an older name. Use create_sub_chat. Stored prompts and triggers in other workspaces that still name it now get an unknown-tool error and must be rewritten.',
	},
	{
		tool: 'create_sub_chat',
		path: 'wait',
		removed: '2026-11-11',
		sweepDate: '2026-11-11',
		decision:
			'Removed on purpose: create_sub_chat always waits for the agent, so there is nothing to switch. A caller that still sends wait is ignored (the schema strips it).',
	},
	{
		tool: 'search_objects',
		removed: '2026-11-02',
		sweepDate: '2027-02-01',
		decision:
			'Folded into list_objects by the list contract (wave 2, T3), which takes q and pages a ranked search behind its one cursor. Kept as a listed alias of list_objects: live in tools/list, see tool-aliases.ts. Maps query to q, driver_id to driver and offset to the cursor offset. Earliest removal 2027-02-01, and only after a clean stored-prompt sweep. Rollback: MASKIN_MCP_LIST_CONTRACT=off restores the old tool (needs a restart).',
	},
]
