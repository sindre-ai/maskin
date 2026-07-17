// Client-side pacing caps for the customer's LinkedIn account, per the bet's
// `linkedin-outreach-pacing` skill. The UI reads these — the agent still owns
// the pacing enforcement (bet `## Not doing`).

export const WARMUP_DAYS = 14

export const PACING_CAPS = {
	healthy: { daily: 20, weekly: 80 },
	warm_up: { daily: 5, weekly: 25 },
	// No sends while setup is mid-flight or the account is blocked.
	handoff: { daily: 0, weekly: 0 },
	syncing: { daily: 0, weekly: 0 },
	restricted: { daily: 0, weekly: 0 },
	reconnect: { daily: 0, weekly: 0 },
} as const

export type LinkedinAccountState = keyof typeof PACING_CAPS

export interface WarmupProgress {
	day: number
	total: number
}

export interface PacingSnapshot {
	dailyCap: number
	dailySent: number
	weeklyCap: number
	weeklySent: number
	warmup: WarmupProgress | null
}

/**
 * Warm-up progress: day 1 begins on `connectedAt`. Once day > WARMUP_DAYS the
 * account has graduated to `healthy` — return null so the UI stops rendering
 * the warm-up chrome.
 */
export function computeWarmupProgress(connectedAt: Date | null): WarmupProgress | null {
	if (!connectedAt) return null
	const elapsedMs = Date.now() - connectedAt.getTime()
	if (elapsedMs < 0) return { day: 1, total: WARMUP_DAYS }
	const day = Math.min(WARMUP_DAYS, Math.floor(elapsedMs / (24 * 60 * 60 * 1000)) + 1)
	return { day, total: WARMUP_DAYS }
}

/**
 * Derive the pacing snapshot the account panel renders. Sent counters land as
 * zero until T3 emits `linkedin_message` send events — the snapshot shape is
 * fixed so the UI does not need to change when that arrives.
 */
export function derivePacing(state: string, connectedAt: Date | null): PacingSnapshot {
	const caps = PACING_CAPS[state as LinkedinAccountState] ?? PACING_CAPS.handoff
	return {
		dailyCap: caps.daily,
		dailySent: 0,
		weeklyCap: caps.weekly,
		weeklySent: 0,
		warmup: state === 'warm_up' ? computeWarmupProgress(connectedAt) : null,
	}
}
