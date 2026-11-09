/**
 * Wraps an async function so at most `max` calls run at once; the rest wait their turn in order.
 * A rejected call frees its slot like any other.
 */
export function limitConcurrency<Args extends unknown[], R>(
	max: number,
	fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
	let running = 0
	const waiting: Array<() => void> = []

	return async (...args) => {
		if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve))
		running += 1
		try {
			return await fn(...args)
		} finally {
			running -= 1
			waiting.shift()?.()
		}
	}
}
