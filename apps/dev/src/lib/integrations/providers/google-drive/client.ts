import { logger } from '../../../logger'
import { DriveError, classifyDriveError } from './errors'

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 8_000
const BACKOFF_MAX_ATTEMPTS = 4
const BACKOFF_JITTER = 0.25

/**
 * Minimal Drive v3 client for the read tools. Interface-shaped so tests inject
 * a fake fetch, same as the Meet write client.
 *
 * 429 and 5xx are retried with exponential backoff (honouring Retry-After); any
 * other non-2xx throws a classified DriveError immediately. Rate-limit-flavoured
 * 403s are not retried here: they carry the retry hint to the agent instead.
 */
export interface DriveClient {
	listFiles(accessToken: string, query: ListFilesQuery): Promise<ListFilesResponse>
}

export interface ListFilesQuery {
	q: string
	pageSize: number
	pageToken?: string
	orderBy?: string
	fields: string
}

export interface DriveApiFile {
	id: string
	name: string
	mimeType: string
	modifiedTime?: string
	parents?: string[]
	owners?: Array<{ displayName?: string; emailAddress?: string }>
	webViewLink?: string
	shortcutDetails?: { targetId?: string; targetMimeType?: string }
}

export interface ListFilesResponse {
	files?: DriveApiFile[]
	nextPageToken?: string
}

export function createDefaultDriveClient(
	fetchImpl: typeof fetch = fetch,
	sleepImpl: (ms: number) => Promise<void> = sleep,
): DriveClient {
	return {
		async listFiles(accessToken, query) {
			const qs = new URLSearchParams({
				q: query.q,
				pageSize: String(query.pageSize),
				fields: query.fields,
				// The connected account's shared drives and shared-with-me files are
				// part of "their Drive"; without these Drive silently omits them.
				supportsAllDrives: 'true',
				includeItemsFromAllDrives: 'true',
			})
			if (query.pageToken) qs.set('pageToken', query.pageToken)
			if (query.orderBy) qs.set('orderBy', query.orderBy)
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${DRIVE_API_BASE}/files?${qs.toString()}`,
				accessToken,
				'drive.files.list',
			)
			return (await parseJson<ListFilesResponse>(res)) as ListFilesResponse
		},
	}
}

async function requestWithRetry(
	fetchImpl: typeof fetch,
	sleepImpl: (ms: number) => Promise<void>,
	url: string,
	accessToken: string,
	operation: string,
): Promise<Response> {
	for (let attempt = 1; attempt <= BACKOFF_MAX_ATTEMPTS; attempt++) {
		let res: Response
		try {
			res = await fetchImpl(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
			})
		} catch (err) {
			if (attempt < BACKOFF_MAX_ATTEMPTS) {
				await sleepImpl(computeBackoff(attempt))
				continue
			}
			logger.warn('Google Drive API network failure exhausted retries', {
				operation,
				attempts: attempt,
				error: String(err),
			})
			throw new DriveError({
				code: 'PROVIDER_ERROR',
				message: `Network failure calling ${operation} after ${attempt} attempts.`,
			})
		}

		if (res.ok) return res

		const retryable = res.status === 429 || res.status >= 500
		if (retryable && attempt < BACKOFF_MAX_ATTEMPTS) {
			await sleepImpl(readRetryAfterMs(res.headers.get('retry-after')) ?? computeBackoff(attempt))
			continue
		}

		throw classifyDriveError({
			status: res.status,
			bodyText: await res.text().catch(() => ''),
			retryAfterHeader: res.headers.get('retry-after'),
		})
	}
	// Unreachable: the loop returns on 2xx or throws on the last attempt.
	throw new DriveError({ code: 'PROVIDER_ERROR', message: `Exhausted retries on ${operation}.` })
}

async function parseJson<T>(res: Response): Promise<T> {
	const text = await res.text()
	if (!text) return {} as T
	try {
		return JSON.parse(text) as T
	} catch {
		throw new DriveError({
			code: 'PROVIDER_ERROR',
			message: 'Google returned a 2xx response with an unparseable body.',
			provider_status: res.status,
		})
	}
}

function computeBackoff(attempt: number): number {
	const exp = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
	const jitter = exp * BACKOFF_JITTER * (Math.random() * 2 - 1)
	return Math.max(0, Math.round(exp + jitter))
}

function readRetryAfterMs(header: string | null): number | undefined {
	if (!header) return undefined
	const asNumber = Number(header)
	if (Number.isFinite(asNumber) && asNumber >= 0)
		return Math.min(asNumber * 1000, BACKOFF_MAX_MS * 2)
	return undefined
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}
