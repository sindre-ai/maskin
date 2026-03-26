/** Format a millisecond duration into a human-readable string. */
export function formatDurationMs(ms: number): string {
	const seconds = Math.floor(ms / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	return `${hours}h ${remainingMinutes}m`
}

/** Format a duration between two ISO date strings. Falls back to now if no end date. */
export function formatDurationBetween(
	startedAt: string | null,
	completedAt: string | null,
): string | null {
	if (!startedAt) return null
	const start = new Date(startedAt).getTime()
	const end = completedAt ? new Date(completedAt).getTime() : Date.now()
	return formatDurationMs(end - start)
}
