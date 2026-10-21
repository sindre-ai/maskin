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
		removed: '2026-10-12',
		sweepDate: '2026-10-15',
		decision:
			'Removed in PR 1986. Restored as a listed alias of create_session (CTO decision D5), built in the old-name event task.',
	},
]
