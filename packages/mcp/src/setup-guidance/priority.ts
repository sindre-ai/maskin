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
	// intent — what is this loop / object for
	conditions_set: 10,
	// agents — is the loop staffed
	steps_have_agents: 20,
	// connectors — providers the prompts reference
	connectors_connected: 40,
	// rest
	has_members: 50,
	elevated_status: 51,
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
