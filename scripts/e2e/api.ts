// Per-request fetch helper with an AbortController-backed timeout. Without
// this, a single hung request would be bounded only by the harness's outer
// wall-clock budget, burning most of the run before producing FAIL.

export interface RequestConfig {
	baseUrl: string
	headers: () => Record<string, string>
	timeoutMs: number
}

export type ApiFn = <T>(method: string, path: string, body?: unknown) => Promise<T>

export function createApiClient(config: RequestConfig): ApiFn {
	return async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), config.timeoutMs)
		try {
			const res = await fetch(`${config.baseUrl}${path}`, {
				method,
				headers: config.headers(),
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			})
			if (!res.ok) {
				const text = await res.text().catch(() => '')
				throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}\n${text}`)
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
