/**
 * HTTP client for the Billy API v2. Three kinds of request exist and nothing else:
 * GET (read), POST of a bill, POST of a file, POST of an attachment. There is no update,
 * delete or approve call, so those cannot be made through this server.
 */

/** The only host this server will ever call. Not configurable on purpose. */
export const API_BASE = 'https://api.billysbilling.com/v2'

const TIMEOUT_MS = 30_000
const MAX_PAGE_SIZE = 1000
const MAX_FILE_BYTES = 10_000_000

export interface Credentials {
	accessToken: string
}

export class BillyApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = 'BillyApiError'
	}
}

/** Accepts a relative API path such as "bills" or "/bills/abc". */
export function safePath(path: string): string {
	const trimmed = path.trim().replace(/^\/+/, '')
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.includes('//') || trimmed.includes('\\')) {
		throw new Error('Only paths on the Billy API are allowed, not full addresses')
	}
	if (trimmed.split('/').some((part) => part === '..' || part === '.')) {
		throw new Error('Path may not contain . or .. parts')
	}
	return trimmed
}

export function buildUrl(path: string, query: Record<string, unknown> = {}): string {
	const url = new URL(`${API_BASE}/${safePath(path)}`)
	if (!url.toString().startsWith(`${API_BASE}/`))
		throw new Error('Refusing to call a host other than Billy')
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue
		url.searchParams.append(key, String(value))
	}
	return url.toString()
}

export class BillyClient {
	constructor(private readonly credentials: Credentials) {}

	private async send(
		method: 'GET' | 'POST',
		path: string,
		init: {
			query?: Record<string, unknown>
			headers?: Record<string, string>
			body?: string | Uint8Array
		},
	): Promise<unknown> {
		const url = buildUrl(path, init.query)
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
		let response: Response
		try {
			response = await fetch(url, {
				method,
				redirect: 'error',
				headers: {
					'X-Access-Token': this.credentials.accessToken,
					Accept: 'application/json',
					...init.headers,
				},
				body: init.body,
				signal: controller.signal,
			})
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				throw new BillyApiError(`Billy did not answer within ${TIMEOUT_MS / 1000}s`, 0)
			}
			throw new BillyApiError('Could not reach Billy', 0)
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
			// Billy's error text can name fields to fix; it never holds our token. Keep it short.
			const detail =
				typeof data === 'object' && data !== null && 'errorMessage' in data
					? String((data as { errorMessage: unknown }).errorMessage).slice(0, 300)
					: ''
			throw new BillyApiError(
				`Billy answered ${response.status} for ${method} /${safePath(path)}${detail ? `: ${detail}` : ''}`,
				response.status,
			)
		}
		return data
	}

	get(path: string, query?: Record<string, unknown>): Promise<unknown> {
		return this.send('GET', path, { query })
	}

	/** Reads a collection with Billy paging (page + pageSize). `key` is the response array. */
	async collection(
		path: string,
		key: string,
		options: { query?: Record<string, unknown>; pageSize?: number; maxItems?: number } = {},
	): Promise<{ items: unknown[]; truncated: boolean }> {
		const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), MAX_PAGE_SIZE)
		const maxItems = Math.min(Math.max(options.maxItems ?? pageSize, 1), 5000)
		const items: unknown[] = []
		let truncated = false
		for (let page = 1; items.length < maxItems; page++) {
			const data = (await this.get(path, { ...options.query, page, pageSize })) as Record<
				string,
				unknown
			> | null
			const rows = Array.isArray(data?.[key]) ? (data[key] as unknown[]) : []
			for (const row of rows) {
				if (items.length >= maxItems) {
					truncated = true
					break
				}
				items.push(row)
			}
			if (rows.length < pageSize) break
			if (items.length >= maxItems) {
				truncated = true
				break
			}
		}
		return { items, truncated }
	}

	/** Saves one bill. The state is forced to draft here, whatever the caller passed. */
	createDraftBill(bill: Record<string, unknown>): Promise<unknown> {
		return this.send('POST', 'bills', {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bill: { ...bill, state: 'draft' } }),
		})
	}

	/** Uploads one receipt file. Billy answers with the stored file. */
	uploadFile(fileName: string, contentType: string, bytes: Buffer, organizationId: string) {
		if (bytes.length === 0) throw new Error('The file is empty')
		if (bytes.length > MAX_FILE_BYTES) throw new Error('The file is larger than 10 MB')
		return this.send('POST', 'files', {
			headers: {
				'Content-Type': contentType,
				'X-Filename': encodeURIComponent(fileName),
				'X-OrganizationId': organizationId,
			},
			body: new Uint8Array(bytes),
		})
	}

	/** Attaches an uploaded file to a bill. */
	attachFileToBill(billId: string, fileId: string): Promise<unknown> {
		return this.send('POST', 'attachments', {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ attachment: { ownerReference: `bill:${billId}`, fileId } }),
		})
	}
}
