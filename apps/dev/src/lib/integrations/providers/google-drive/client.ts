import { logger } from '../../../logger'
import { DriveError, classifyDriveError } from './errors'

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 8_000
const BACKOFF_MAX_ATTEMPTS = 4
const BACKOFF_JITTER = 0.25

/**
 * changes.list returns only a minimal file (kind, id, name, mimeType) unless the
 * mask names the file fields, so a bare `changes(*)` would hide parents and
 * trashed.
 */
const CHANGES_FIELDS =
	'nextPageToken,newStartPageToken,changes(fileId,removed,time,changeType,file(id,name,mimeType,parents,trashed,createdTime,modifiedTime))'

/**
 * Minimal Drive v3 client for the read tools and the folder-watch channel
 * calls. Interface-shaped so tests inject a fake fetch, same as the Meet write
 * client.
 *
 * 429 and 5xx are retried with exponential backoff (honouring Retry-After); any
 * other non-2xx throws a classified DriveError immediately. Rate-limit-flavoured
 * 403s are not retried here: they carry the retry hint to the agent instead.
 * The two POSTs (changes.watch, channels.stop) retry on 429 only.
 */
export interface DriveClient {
	listFiles(accessToken: string, query: ListFilesQuery): Promise<ListFilesResponse>
	/** changes.getStartPageToken: the cursor "from now" for changes.list and changes.watch. */
	getStartPageToken(accessToken: string): Promise<string>
	/** changes.watch: open an HTTPS notification channel on the account's change feed. */
	watchChanges(accessToken: string, params: WatchChangesParams): Promise<WatchChangesResponse>
	/** channels.stop: end a notification channel. Drive answers 204 with no body. */
	stopChannel(accessToken: string, params: { id: string; resourceId: string }): Promise<void>
	/** changes.list: one page of the change feed from the page token. */
	listChanges(accessToken: string, params: ListChangesParams): Promise<ListChangesResponse>
	/** files.get with an explicit fields mask (folder and parent-chain lookups). */
	getFile(accessToken: string, fileId: string, fields: string): Promise<DriveApiFile>
}

export interface WatchChangesParams {
	pageToken: string
	channelId: string
	address: string
	token: string
	/** Requested channel expiry, epoch ms. Google may clamp it. */
	expiration: number
}

export interface WatchChangesResponse {
	resourceId: string
	/** Granted expiry, epoch ms as a string. Absent when Google omits it. */
	expiration?: string
}

export interface ListChangesParams {
	pageToken: string
	pageSize?: number
}

export interface DriveChange {
	fileId?: string
	removed?: boolean
	time?: string
	changeType?: string
	file?: DriveApiFile
}

export interface ListChangesResponse {
	changes?: DriveChange[]
	nextPageToken?: string
	newStartPageToken?: string
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
	trashed?: boolean
	createdTime?: string
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

		async getStartPageToken(accessToken) {
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${DRIVE_API_BASE}/changes/startPageToken?supportsAllDrives=true`,
				accessToken,
				'drive.changes.getStartPageToken',
			)
			const body = await parseJson<{ startPageToken?: string }>(res)
			if (!body.startPageToken) {
				throw new DriveError({
					code: 'PROVIDER_ERROR',
					message: 'Google returned no startPageToken.',
					provider_status: res.status,
				})
			}
			return body.startPageToken
		},

		async watchChanges(accessToken, params) {
			const qs = new URLSearchParams({ pageToken: params.pageToken, supportsAllDrives: 'true' })
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${DRIVE_API_BASE}/changes/watch?${qs.toString()}`,
				accessToken,
				'drive.changes.watch',
				{
					id: params.channelId,
					type: 'web_hook',
					address: params.address,
					token: params.token,
					expiration: String(params.expiration),
				},
			)
			const body = await parseJson<{ resourceId?: string; expiration?: string }>(res)
			if (!body.resourceId) {
				throw new DriveError({
					code: 'PROVIDER_ERROR',
					message: 'Google returned no resourceId for the notification channel.',
					provider_status: res.status,
				})
			}
			return { resourceId: body.resourceId, expiration: body.expiration }
		},

		async stopChannel(accessToken, params) {
			await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${DRIVE_API_BASE}/channels/stop`,
				accessToken,
				'drive.channels.stop',
				{ id: params.id, resourceId: params.resourceId },
			)
		},

		async listChanges(accessToken, params) {
			const qs = new URLSearchParams({
				pageToken: params.pageToken,
				pageSize: String(params.pageSize ?? 100),
				fields: CHANGES_FIELDS,
				supportsAllDrives: 'true',
				includeItemsFromAllDrives: 'true',
				includeRemoved: 'true',
				spaces: 'drive',
			})
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${DRIVE_API_BASE}/changes?${qs.toString()}`,
				accessToken,
				'drive.changes.list',
			)
			return (await parseJson<ListChangesResponse>(res)) as ListChangesResponse
		},

		async getFile(accessToken, fileId, fields) {
			const qs = new URLSearchParams({ fields, supportsAllDrives: 'true' })
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${qs.toString()}`,
				accessToken,
				'drive.files.get',
			)
			return (await parseJson<DriveApiFile>(res)) as DriveApiFile
		},
	}
}

export async function requestWithRetry(
	fetchImpl: typeof fetch,
	sleepImpl: (ms: number) => Promise<void>,
	url: string,
	accessToken: string,
	operation: string,
	postBody?: Record<string, unknown>,
): Promise<Response> {
	// A POST (channel create or stop) is retried on 429 only: re-sending after a
	// 5xx or a dropped connection could open a second channel the first call
	// already created.
	const isPost = postBody !== undefined
	for (let attempt = 1; attempt <= BACKOFF_MAX_ATTEMPTS; attempt++) {
		let res: Response
		try {
			res = await fetchImpl(url, {
				method: isPost ? 'POST' : 'GET',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
					...(isPost ? { 'Content-Type': 'application/json' } : {}),
				},
				...(isPost ? { body: JSON.stringify(postBody) } : {}),
			})
		} catch (err) {
			if (!isPost && attempt < BACKOFF_MAX_ATTEMPTS) {
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

		const retryable = res.status === 429 || (res.status >= 500 && !isPost)
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

export async function parseJson<T>(res: Response): Promise<T> {
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

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}
