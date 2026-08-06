/** Renders a millisecond duration as a compact "12d" / "3h" / "9m" / "45s"
 * string, or null when there's nothing to show yet. Distinct from
 * `formatDurationMs` in `format-duration.ts` (which formats elapsed session
 * time as "3m 45s") — loop median-close durations round to a single unit. */
export function formatLoopDurationMs(ms: number | null): string | null {
	if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return null
	const seconds = ms / 1000
	const minutes = seconds / 60
	const hours = minutes / 60
	const days = hours / 24
	if (days >= 1) return `${Math.round(days)}d`
	if (hours >= 1) return `${Math.round(hours)}h`
	if (minutes >= 1) return `${Math.round(minutes)}m`
	return `${Math.round(seconds)}s`
}

/** Same as {@link formatLoopDurationMs} with a trailing " median" label, for
 * inline row copy like "128 closed · 12d median". */
export function formatLoopMedianMs(ms: number | null): string | null {
	const duration = formatLoopDurationMs(ms)
	return duration ? `${duration} median` : null
}
