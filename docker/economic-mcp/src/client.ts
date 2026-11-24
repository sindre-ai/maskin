/**
 * HTTP client for the e-conomic REST API.
 *
 * Derived from src/economicClient.ts in available-dev/e-conomic-mcp at commit
 * 164567c616b7a734954b0fe7b965a3d56297fadf (MIT, Copyright (c) 2026 Available A/S).
 * Changes: one fixed host, relative paths only, credentials passed per client. Reads are GET.
 * The only writes are createVoucher (save a draft in a journal) and attachReceipt (add a file to
 * one voucher). Both build their own path from checked numbers, so there is no way to POST,
 * PUT, PATCH or DELETE anywhere else, and nothing here books a journal.
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

export interface ReceiptFile {
	filename: string
	mimeType: string
	bytes: Uint8Array
}

const RECEIPT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif']
export const MAX_RECEIPT_BYTES = 4_000_000

function checkedInt(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 999_999_999) {
		throw new Error(`${name} must be a whole number above 0`)
	}
	return value
}

function checkedYear(value: unknown): string {
	if (typeof value !== 'string' || !/^\d{4}$/.test(value)) {
		throw new Error('accountingYear must be four digits, for example "2025"')
	}
	return value
}

async function send(
	credentials: Credentials,
	method: 'GET' | 'POST',
	path: string,
	options: { query?: Record<string, unknown>; json?: unknown; form?: FormData } = {},
): Promise<unknown> {
	const url = buildUrl(path, options.query)
	const headers: Record<string, string> = {
		'X-AppSecretToken': credentials.appSecretToken,
		'X-AgreementGrantToken': credentials.agreementGrantToken,
		Accept: 'application/json',
	}
	let body: string | FormData | undefined
	if (options.json !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.json)
	} else if (options.form) {
		body = options.form
	}
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
	let response: Response
	try {
		response = await fetch(url, {
			method,
			redirect: 'error',
			headers,
			body,
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
			`e-conomic answered ${response.status} for ${method} /${safePath(path)}`,
			response.status,
			data,
		)
	}
	return data
}

export class EconomicClient {
	constructor(private readonly credentials: Credentials) {}

	async get(path: string, query?: Record<string, unknown>): Promise<unknown> {
		return send(this.credentials, 'GET', path, { query })
	}

	/**
	 * Saves entries as a voucher in a journal. e-conomic keeps them in the journal, not booked,
	 * until a person books the journal in e-conomic. This server has no way to book.
	 */
	async createVoucher(journalNumber: number, voucher: Record<string, unknown>): Promise<unknown> {
		const journal = checkedInt(journalNumber, 'journalNumber')
		return send(this.credentials, 'POST', `journals/${journal}/vouchers`, { json: voucher })
	}

	/** Adds one receipt file to a voucher that is still in the journal. */
	async attachReceipt(
		journalNumber: number,
		accountingYear: string,
		voucherNumber: number,
		file: ReceiptFile,
	): Promise<unknown> {
		const journal = checkedInt(journalNumber, 'journalNumber')
		const year = checkedYear(accountingYear)
		const voucher = checkedInt(voucherNumber, 'voucherNumber')
		if (!RECEIPT_TYPES.includes(file.mimeType)) {
			throw new Error('The receipt must be a PDF, PNG, JPEG or GIF file')
		}
		if (file.bytes.length === 0 || file.bytes.length > MAX_RECEIPT_BYTES) {
			throw new Error(`The receipt must be between 1 byte and ${MAX_RECEIPT_BYTES / 1_000_000} MB`)
		}
		const form = new FormData()
		form.append('file', new Blob([file.bytes], { type: file.mimeType }), file.filename)
		return send(
			this.credentials,
			'POST',
			`journals/${journal}/vouchers/${year}-${voucher}/attachment/file`,
			{ form },
		)
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
