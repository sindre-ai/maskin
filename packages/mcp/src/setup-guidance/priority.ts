import type { SetupCheck, SetupCheckStatus } from './types'

/**
 * Severity weight — fails always come before warns, warns before unknowns.
 */
const STATUS_WEIGHT: Record<SetupCheckStatus, number> = {
	fail: 0,
	warn: 1,
	unknown: 2,
}

/**
 * Within-severity ordering by check name — intent questions first, then
 * agents, triggers, connectors, everything else. Lower = earlier.
 */
const CHECK_ORDER: Record<string, number> = {
	// intent — what is this loop / object / agent for
	conditions_set: 10,
	system_prompt_quality: 11,
	// agents — is the loop/actor staffed
	steps_have_agents: 20,
	skills_attached: 21,
	mcp_configured: 22,
	// connectors — providers the prompts reference
	connectors_connected: 40,
	// content & ownership — objects
	content_quality: 45,
	driver_set: 46,
	status_progression: 47,
	// rest
	has_members: 50,
	dry_run_suggested: 90,
}

const CHECK_ORDER_DEFAULT = 999

export function sortByPriority(checks: SetupCheck[]): SetupCheck[] {
	return [...checks].sort((a, b) => {
		const sa = STATUS_WEIGHT[a.status] ?? 99
		const sb = STATUS_WEIGHT[b.status] ?? 99
		if (sa !== sb) return sa - sb
		const oa = CHECK_ORDER[a.name] ?? CHECK_ORDER_DEFAULT
		const ob = CHECK_ORDER[b.name] ?? CHECK_ORDER_DEFAULT
		if (oa !== ob) return oa - ob
		return a.name.localeCompare(b.name)
	})
}

/**
 * Top-N slice used by the create/update response `next_steps` block. Default
 * matches the parent bet's contract of surfacing three action items per call.
 */
export function toNextSteps(checks: SetupCheck[], limit = 3): SetupCheck[] {
	return sortByPriority(checks).slice(0, Math.max(0, limit))
}
