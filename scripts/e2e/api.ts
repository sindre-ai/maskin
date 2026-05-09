// Per-request fetch helper with an AbortController-backed timeout. Without
// this, a single hung request would be bounded only by the harness's outer
// wall-clock budget, burning most of the run before producing FAIL.
//
// On non-OK HTTP responses this throws ApiError so the outer retry layer
// (retry.ts) can identify transient statuses (5xx/429/etc.) and back off.

import { ApiError } from './retry'

export interface RequestConfig {
	baseUrl: string
	headers: () => Record<string, string>
	timeoutMs: number
}

export interface RequestOptions {
	idempotencyKey?: string
}

export type ApiFn = <T>(
	method: string,
	path: string,
	body?: unknown,
	options?: RequestOptions,
) => Promise<T>

export function createApiClient(config: RequestConfig): ApiFn {
	return async function api<T>(
		method: string,
		path: string,
		body?: unknown,
		options: RequestOptions = {},
	): Promise<T> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), config.timeoutMs)
		try {
			const extraHeaders: Record<string, string> = {}
			if (options.idempotencyKey) extraHeaders['Idempotency-Key'] = options.idempotencyKey
			const res = await fetch(`${config.baseUrl}${path}`, {
				method,
				headers: { ...config.headers(), ...extraHeaders },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			})
			if (!res.ok) {
				const text = await res.text().catch(() => '')
				throw new ApiError(res.status, method, path, text, res.statusText)
			}
			if (res.status === 204) return undefined as T
			return (await res.json()) as T
		} catch (err) {
			if (controller.signal.aborted && (err as Error | undefined)?.name === 'AbortError') {
				throw new Error(
					`${method} ${path} aborted after ${config.timeoutMs / 1000}s (E2E_REQUEST_TIMEOUT_SEC)`,
				)
			}
			throw err
		} finally {
			clearTimeout(timer)
		}
	}
}
