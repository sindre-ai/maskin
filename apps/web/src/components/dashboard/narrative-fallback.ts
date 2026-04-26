/**
 * Deterministic English sentence describing the workspace state. Mirrors the
 * backend `buildFallbackHeadline` in
 * `apps/dev/src/services/dashboard-headline.ts` so the headline strip can
 * render synchronously on first paint and during network/error states without
 * a spinner or blank.
 *
 * Selection order (highest priority first, matching the backend):
 *   1. Pending decisions — captain action required
 *   2. Live sessions — agents shipping work
 *   3. Recent activity — quiet but not idle
 *   4. Idle — no signal at all
 */

export interface NarrativeFallbackInput {
	runningSessions: number
	pendingNotifications: number
	eventsLast24h: number
	uniqueAgentsLast24h: number
}

export function buildFallbackHeadline(input: NarrativeFallbackInput): string {
	const { runningSessions, pendingNotifications, eventsLast24h, uniqueAgentsLast24h } = input

	if (pendingNotifications > 0) {
		const decisionWord = pendingNotifications === 1 ? 'decision is' : 'decisions are'
		if (runningSessions > 0) {
			const agentWord = runningSessions === 1 ? 'agent is' : 'agents are'
			return `${runningSessions} ${agentWord} working; ${pendingNotifications} ${decisionWord} waiting on you.`
		}
		return `${pendingNotifications} ${decisionWord} waiting on you.`
	}

	if (runningSessions > 0) {
		const agentWord = runningSessions === 1 ? 'agent is' : 'agents are'
		return `${runningSessions} ${agentWord} shipping work — nothing needs your call right now.`
	}

	if (eventsLast24h > 0) {
		const agentWord = uniqueAgentsLast24h === 1 ? 'agent' : 'agents'
		const count = uniqueAgentsLast24h || 1
		return `${count} ${agentWord} moved things forward today; the team is at rest now.`
	}

	return 'The team is at rest — no agents are working and nothing needs your call.'
}
