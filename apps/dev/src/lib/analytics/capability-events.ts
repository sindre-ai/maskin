import { capturePosthogEvent } from './posthog'

export interface CapabilityScanCompletedProps {
	workspace_id: string
	mode: 'baseline' | 'diff'
	sources_total: number
	sources_failed: number
	unscanned_servers: number
	tools_total: number
	tools_added: number
	tools_removed: number
	schema_changed: number
	findings_eligible: number
	duration_ms: number
	/** The scan is a server job. Always 0; kept as a field so a regression shows up. */
	model_calls: 0
}

/**
 * One event per workspace per tick, not one per integration. Counts only: no
 * tool names, no agent ids, no descriptions. The database twin is the
 * capability_scan_completed events row written in the same tick.
 */
export async function trackCapabilityScanCompleted(p: CapabilityScanCompletedProps): Promise<void> {
	await capturePosthogEvent('capability_scan_completed', p.workspace_id, { ...p })
}
