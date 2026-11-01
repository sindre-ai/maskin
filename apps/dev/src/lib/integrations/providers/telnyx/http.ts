import { logger } from '../../../logger'

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 250
const DEFAULT_TIMEOUT_MS = 10_000

export class TelnyxHttpError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
		readonly body: string | null,
	) {
		super(message)
		this.name = 'TelnyxHttpError'
	}
}

export interface DeadLetter {
	method: string
	url: string
	attempts: number
	status: number | null
	error: string
	idempotencyKey?: string
}

/** Called once when a request has exhausted its retries. Posts to #sales at Attention 5. */
export type DeadLetterHandler = (letter: DeadLetter) => void | Promise<void>

export interface TelnyxFetchOptions {
	method: string
	headers?: Record<string, string>
	body?: string
	/** Sent as the Idempotency-Key header: contact_id:dial_attempt_n. */
	idempotencyKey?: string
	onDeadLetter?: DeadLetterHandler
	fetchImpl?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	random?: () => number
	timeoutMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isConnectTimeout(err: unknown): boolean {
	if (!(err instanceof Error)) return false
	const code = (err as { code?: string; cause?: { code?: string } }).code
	const causeCode = (err as { cause?: { code?: string } }).cause?.code
	return (
		err.name === 'TimeoutError' ||
		err.name === 'AbortError' ||
		code === 'ETIMEDOUT' ||
		code === 'UND_ERR_CONNECT_TIMEOUT' ||
		causeCode === 'ETIMEDOUT' ||
		causeCode === 'UND_ERR_CONNECT_TIMEOUT'
	)
}

/**
 * fetch with exponential backoff + full jitter, 3 attempts. Retries only on
 * 5xx and connect-timeout; a 4xx surfaces immediately as a TelnyxHttpError. A
 * request that fails its last attempt calls onDeadLetter and then throws.
 *
 * Inline on purpose: the Telnyx client is the only consumer. There is no
 * apps/dev/src/lib/retryable-http.ts to import.
 */
export async function telnyxFetch(url: string, opts: TelnyxFetchOptions): Promise<Response> {
	const doFetch = opts.fetchImpl ?? fetch
	const sleep = opts.sleep ?? defaultSleep
	const random = opts.random ?? Math.random
	const headers: Record<string, string> = { ...opts.headers }
	if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

	let lastStatus: number | null = null
	let lastError = 'unknown error'

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let retryable = false
		try {
			const res = await doFetch(url, {
				method: opts.method,
				headers,
				body: opts.body,
				signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			})
			if (res.status < 500) {
				if (res.ok) return res
				// 4xx: the caller's problem, never retried, never dead-lettered.
				throw new TelnyxHttpError(
					`Telnyx ${opts.method} ${url} failed with ${res.status}`,
					res.status,
					await res.text().catch(() => null),
				)
			}
			retryable = true
			lastStatus = res.status
			lastError = `HTTP ${res.status}`
		} catch (err) {
			if (err instanceof TelnyxHttpError) throw err
			if (!isConnectTimeout(err)) throw err
			retryable = true
			lastStatus = null
			lastError = err instanceof Error ? err.message : String(err)
		}

		if (retryable && attempt < MAX_ATTEMPTS) {
			const backoff = BASE_DELAY_MS * 2 ** (attempt - 1)
			await sleep(Math.floor(random() * backoff))
		}
	}

	const letter: DeadLetter = {
		method: opts.method,
		url,
		attempts: MAX_ATTEMPTS,
		status: lastStatus,
		error: lastError,
		idempotencyKey: opts.idempotencyKey,
	}
	try {
		await opts.onDeadLetter?.(letter)
	} catch (err) {
		logger.error('telnyx dead-letter handler failed', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
	throw new TelnyxHttpError(
		`Telnyx ${opts.method} ${url} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
		lastStatus,
		null,
	)
}
