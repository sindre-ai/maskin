/**
 * Read-only HTTP client for the e-conomic REST API.
 *
 * Derived from src/economicClient.ts in available-dev/e-conomic-mcp at commit
 * 164567c616b7a734954b0fe7b965a3d56297fadf (MIT, Copyright (c) 2026 Available A/S).
 * Changes: GET only, one fixed host, relative paths only, credentials passed per client.
 */

/** The only host this server will ever call. Not configurable on purpose. */
export const API_BASE = 'https://restapi.e-conomic.com'

const TIMEOUT_MS = 30_000
const MAX_PAGE_SIZE = 1000

export interface Credentials {
	appSecretToken: string
	agreementGrantToken: string
}

export class EconomicApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: unknown,
	) {
		super(message)
		this.name = 'EconomicApiError'
	}
}

/** Accepts a relative API path such as "customers" or "/accounting-years/2025/entries". */
export function safePath(path: string): string {
	const trimmed = path.trim().replace(/^\/+/, '')
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.includes('//') || trimmed.includes('\\')) {
		throw new Error('Only paths on the e-conomic API are allowed, not full addresses')
	}
	if (trimmed.split('/').some((part) => part === '..' || part === '.')) {
		throw new Error('Path may not contain . or .. parts')
	}
	return trimmed
}

export function buildUrl(path: string, query: Record<string, unknown> = {}): string {
	const url = new URL(`${API_BASE}/${safePath(path)}`)
	if (url.origin !== API_BASE) throw new Error('Refusing to call a host other than e-conomic')
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue
		url.searchParams.append(key, String(value))
	}
	return url.toString()
}

export class EconomicClient {
	constructor(private readonly credentials: Credentials) {}

	async get(path: string, query?: Record<string, unknown>): Promise<unknown> {
		const url = buildUrl(path, query)
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
		let response: Response
		try {
			response = await fetch(url, {
				method: 'GET',
				redirect: 'error',
				headers: {
					'X-AppSecretToken': this.credentials.appSecretToken,
					'X-AgreementGrantToken': this.credentials.agreementGrantToken,
					Accept: 'application/json',
				},
				signal: controller.signal,
			})
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				throw new EconomicApiError(`e-conomic did not answer within ${TIMEOUT_MS / 1000}s`, 0, null)
			}
			throw new EconomicApiError('Could not reach e-conomic', 0, null)
		} finally {
			clearTimeout(timer)
		}
		const text = await response.text()
		let data: unknown = text
		try {
			data = text ? JSON.parse(text) : null
		} catch {
			// keep the text
		}
		if (!response.ok) {
			throw new EconomicApiError(
				`e-conomic answered ${response.status} for GET /${safePath(path)}`,
				response.status,
				data,
			)
		}
		return data
	}

	/** Reads a collection with e-conomic paging (skippages + pagesize). */
	async collection(
		path: string,
		options: { filter?: string; sort?: string; pageSize?: number; maxItems?: number } = {},
	): Promise<{ items: unknown[]; truncated: boolean }> {
		const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), MAX_PAGE_SIZE)
		const maxItems = Math.min(Math.max(options.maxItems ?? pageSize, 1), 5000)
		const items: unknown[] = []
		let truncated = false
		for (let skippages = 0; items.length < maxItems; skippages++) {
			const data = (await this.get(path, {
				skippages,
				pagesize: pageSize,
				filter: options.filter,
				sort: options.sort,
			})) as { collection?: unknown[]; pagination?: { nextPage?: string } } | null
			const page = Array.isArray(data?.collection) ? data.collection : []
			for (const item of page) {
				if (items.length >= maxItems) {
					truncated = true
					break
				}
				items.push(item)
			}
			const more = typeof data?.pagination?.nextPage === 'string' && data.pagination.nextPage !== ''
			if (!more || page.length < pageSize) break
			if (items.length >= maxItems) {
				truncated = true
				break
			}
		}
		return { items, truncated }
	}
}
