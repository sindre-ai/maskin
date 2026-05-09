// Bounded retry with exponential backoff for transient HTTP and network
// errors. Used by the harness so a single 502/503 from the live workspace —
// which a 90-minute scheduled run is statistically guaranteed to encounter —
// does not abort the entire run.

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
		body: string,
		statusText: string,
	) {
		super(`${method} ${path} -> ${status} ${statusText}\n${body}`)
		this.name = 'ApiError'
	}
}

export const TRANSIENT_HTTP_STATUS: ReadonlySet<number> = new Set([
	408, 425, 429, 500, 502, 503, 504,
])

export function isRetriable(err: unknown): boolean {
	if (err instanceof ApiError) return TRANSIENT_HTTP_STATUS.has(err.status)
	// Native fetch raises TypeError for network/DNS failures and aborts.
	if (err instanceof TypeError) return true
	return false
}

export interface RetryOptions {
	retries?: number
	baseDelayMs?: number
	label: string
	onRetry?: (info: { attempt: number; delayMs: number; error: Error; label: string }) => void
	sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function withRetries<T>(
	op: (attempt: number) => Promise<T>,
	opts: RetryOptions,
): Promise<T> {
	const retries = opts.retries ?? 3
	const baseDelay = opts.baseDelayMs ?? 500
	const sleep = opts.sleep ?? defaultSleep
	let attempt = 0
	while (true) {
		try {
			return await op(attempt)
		} catch (err) {
			if (!isRetriable(err) || attempt >= retries) throw err
			const delay = baseDelay * 2 ** attempt
			opts.onRetry?.({ attempt, delayMs: delay, error: err as Error, label: opts.label })
			await sleep(delay)
			attempt++
		}
	}
}
