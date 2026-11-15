/**
 * Runs independent async tasks with at most `limit` in flight, returning the
 * results in input order. Rejects with the first failure; tasks not yet
 * started are then skipped.
 *
 * Used where a handler would otherwise fan out many queries at once and take
 * a connection each from a small pool.
 */
export async function runLimited<T>(
	limit: number,
	tasks: ReadonlyArray<() => Promise<T>>,
): Promise<T[]> {
	const results = new Array<T>(tasks.length)
	let next = 0
	let failed = false
	const worker = async () => {
		while (!failed) {
			const index = next++
			if (index >= tasks.length) return
			try {
				results[index] = await (tasks[index] as () => Promise<T>)()
			} catch (error) {
				failed = true
				throw error
			}
		}
	}
	const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker)
	await Promise.all(workers)
	return results
}
