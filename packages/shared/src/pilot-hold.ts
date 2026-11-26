/**
 * What a flow in pilot holds for a person: every step that leaves the company or cannot be undone.
 * One place to edit. Read by the server check (apps/dev/src/lib/pilot-hold.ts) and by the MCP
 * server that fronts the Maskin tools (packages/mcp).
 *
 * Named from the code, not from the spec's first guess. Public pages have no tool of their own:
 * publishing one is a write through an outside integration (a GitHub push or pull request on the
 * website repo, a Drive write), so it falls under the integration rule below.
 */

/** The Maskin tools that reach outside or cannot be undone. Normal writes inside Maskin are not here. */
export const PILOT_HELD_MASKIN_TOOLS: ReadonlySet<string> = new Set([
	'delete_object',
	'delete_file',
	'delete_loop',
	'delete_trigger',
	'fork_loop',
	'create_notification',
])

/**
 * Providers whose sends already wait for a person's approval of the exact text, in every flow
 * (send-gate.ts). Pilot adds no second card for them, so their tools are not held here.
 */
export const OWN_HOLD_PROVIDERS: ReadonlySet<string> = new Set([
	'slack',
	'linkedin-unipile',
	'gmail',
	'resend',
])

/**
 * Whether a Maskin tool waits in pilot. A tool is held when it is on the list above or has no
 * entry in the platform's tool table (extension tools, and any tool added without being
 * classified): an unclassified tool counts as outbound.
 */
export function isPilotHeldMaskinTool(name: string, classified: boolean): boolean {
	return PILOT_HELD_MASKIN_TOOLS.has(name) || !classified
}

/** Whether a tool of an outside integration waits in pilot: any write, unless it has its own hold. */
export function isPilotHeldIntegrationTool(provider: string, kind: 'read' | 'write'): boolean {
	return kind === 'write' && !OWN_HOLD_PROVIDERS.has(provider)
}

/** The first line of every refusal and card. Same words in every place. */
export const PILOT_REFUSAL = 'This flow is in pilot, so sends wait for a person'
