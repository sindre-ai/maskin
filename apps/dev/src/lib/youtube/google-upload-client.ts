import type { Readable } from 'node:stream'
import type { PublishPayload, UploadPayload } from './upload'

/**
 * The part of the Google write client that moves video bytes and changes who can watch a video.
 * Like `google-write-client.ts`, import it from `executor.ts` and nowhere else: a test fails if any
 * other module does.
 *
 * Privacy is enforced here, not trusted from the request. Google now treats an upload with no
 * privacy status as public, so `buildInsertBody` always writes private and `startUploadSession`
 * refuses any body that does not say so. Results carry a category and a code, never Google's text.
 */

const API = 'https://www.googleapis.com/youtube/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3'
const REQUEST_TIMEOUT_MS = 60_000
/** Google wants chunks in multiples of 256 KiB (the last one aside). 8 MiB is all the memory one upload holds. */
export const UPLOAD_CHUNK_BYTES = 32 * 256 * 1024
const CHUNK_TRIES = 3

export type SessionResult =
	| { ok: true; sessionUri: string }
	| { ok: false; code: string; retryable: boolean }

export type UploadResult =
	| { state: 'done'; videoId: string }
	| { state: 'interrupted' }
	| { state: 'failed'; code: string }

export type PublishResult = { ok: true } | { ok: false; code: string }

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

/** The JSON Google gets when an upload starts. Private is written here whatever the request held. */
export function buildInsertBody(payload: UploadPayload): Record<string, unknown> {
	return {
		snippet: {
			title: payload.title,
			description: payload.description,
			...(payload.tags ? { tags: payload.tags } : {}),
			...(payload.categoryId ? { categoryId: payload.categoryId } : {}),
		},
		status: {
			privacyStatus: 'private',
			...(payload.containsSyntheticMedia ? { containsSyntheticMedia: true } : {}),
		},
	}
}

function isPrivateBody(body: Record<string, unknown>): boolean {
	const status = body.status as { privacyStatus?: unknown } | undefined
	return status?.privacyStatus === 'private'
}

function authHeaders(accessToken: string): Record<string, string> {
	return { Authorization: `Bearer ${accessToken}` }
}

/** Opens a resumable upload. Fails, without calling Google, for any body that is not private. */
export async function startUploadSession(request: {
	accessToken: string
	body: Record<string, unknown>
	sizeBytes: number
	mimeType: string
}): Promise<SessionResult> {
	if (!isPrivateBody(request.body)) {
		return { ok: false, code: 'privacy_not_private', retryable: false }
	}
	let response: Response
	try {
		response = await fetch(`${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`, {
			method: 'POST',
			headers: {
				...authHeaders(request.accessToken),
				'Content-Type': 'application/json; charset=UTF-8',
				'X-Upload-Content-Length': String(request.sizeBytes),
				'X-Upload-Content-Type': request.mimeType,
			},
			body: JSON.stringify(request.body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch {
		return { ok: false, code: 'request_failed', retryable: true }
	}
	const location = response.headers.get('location')
	if (!response.ok || !location) {
		return {
			ok: false,
			code: response.ok ? 'no_session' : `http_${response.status}`,
			retryable: RETRYABLE.has(response.status),
		}
	}
	return { ok: true, sessionUri: location }
}

type Progress =
	| { kind: 'received'; next: number }
	| { kind: 'done'; videoId: string }
	| { kind: 'gone' }
	| { kind: 'error'; code: string; retryable: boolean }

/** How far Google got: the next byte it wants, or the finished video. */
function readProgress(response: Response, body: string): Progress {
	if (response.status === 200 || response.status === 201) {
		try {
			const id = (JSON.parse(body) as { id?: unknown }).id
			if (typeof id === 'string' && id.length > 0) return { kind: 'done', videoId: id }
		} catch {
			// fall through to the error below
		}
		return { kind: 'error', code: 'no_video_id', retryable: false }
	}
	if (response.status === 308) {
		const range = response.headers.get('range')
		const match = range ? /^bytes=0-(\d+)$/.exec(range) : null
		return { kind: 'received', next: match ? Number(match[1]) + 1 : 0 }
	}
	if (response.status === 404 || response.status === 410) return { kind: 'gone' }
	return {
		kind: 'error',
		code: `http_${response.status}`,
		retryable: RETRYABLE.has(response.status),
	}
}

async function put(
	sessionUri: string,
	accessToken: string,
	headers: Record<string, string>,
	body?: Uint8Array,
): Promise<Progress> {
	try {
		const response = await fetch(sessionUri, {
			method: 'PUT',
			headers: { ...authHeaders(accessToken), ...headers },
			...(body ? { body: body as RequestInit['body'] } : {}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		const text = response.status === 200 || response.status === 201 ? await response.text() : ''
		return readProgress(response, text)
	} catch {
		return { kind: 'error', code: 'request_failed', retryable: true }
	}
}

/** Asks Google how much of the file it holds. The truth after a cut-off, whatever we last stored. */
export function queryUploadStatus(
	sessionUri: string,
	accessToken: string,
	totalBytes: number,
): Promise<Progress> {
	// An empty PUT: fetch sends Content-Length 0 itself.
	return put(sessionUri, accessToken, { 'Content-Range': `bytes */${totalBytes}` })
}

/** Reads `skip` bytes off the front of a stream and yields the rest in chunks of `size`. Memory is one chunk. */
async function* chunksFrom(source: Readable, skip: number, size: number) {
	let toSkip = skip
	let pending: Buffer[] = []
	let held = 0
	for await (const part of source) {
		let piece = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array)
		if (toSkip > 0) {
			const dropped = Math.min(toSkip, piece.length)
			toSkip -= dropped
			piece = piece.subarray(dropped)
			if (piece.length === 0) continue
		}
		pending.push(piece)
		held += piece.length
		while (held >= size) {
			const whole = Buffer.concat(pending)
			yield whole.subarray(0, size)
			const rest = whole.subarray(size)
			pending = rest.length > 0 ? [rest] : []
			held = rest.length
		}
	}
	if (held > 0) yield Buffer.concat(pending)
}

export interface UploadRequest {
	sessionUri: string
	/** Asked for before every request, because a long upload outlives one access token. */
	getAccessToken: () => Promise<string>
	totalBytes: number
	/** Opens the file again from the start. Called once; the stream is read forward only. */
	openFile: () => Promise<Readable>
	/** Called with the byte count Google confirmed after each chunk. Never throws into the upload. */
	onProgress: (bytesSent: number) => Promise<void>
}

/**
 * Sends the file in chunks, asking Google where it is after any failure, until the video exists.
 * The file is read as a stream and only one chunk is ever in memory. A cut-off that outlasts the
 * retries returns `interrupted`, and the stored progress lets the next run carry on from there.
 */
export async function uploadFile(request: UploadRequest): Promise<UploadResult> {
	const { sessionUri, totalBytes } = request
	const query = async () =>
		queryUploadStatus(sessionUri, await request.getAccessToken(), totalBytes)

	// Start from what Google holds, not from what we think it holds.
	const first = await query()
	if (first.kind === 'done') return { state: 'done', videoId: first.videoId }
	if (first.kind === 'gone') return { state: 'failed', code: 'session_expired' }
	if (first.kind === 'error') {
		return first.retryable ? { state: 'interrupted' } : { state: 'failed', code: first.code }
	}
	let confirmed = first.next
	await request.onProgress(confirmed)

	const file = await request.openFile()
	try {
		let position = confirmed
		for await (const chunk of chunksFrom(file, confirmed, UPLOAD_CHUNK_BYTES)) {
			const chunkStart = position
			const chunkEnd = chunkStart + chunk.length
			let progress: Progress | null = null
			for (let attempt = 0; attempt < CHUNK_TRIES; attempt++) {
				const from = Math.max(chunkStart, confirmed)
				progress = await put(
					sessionUri,
					await request.getAccessToken(),
					{ 'Content-Range': `bytes ${from}-${chunkEnd - 1}/${totalBytes}` },
					chunk.subarray(from - chunkStart),
				)
				if (progress.kind === 'error' && progress.retryable) {
					// Ask Google how much of that chunk it kept, then send only the rest.
					const status = await query()
					if (status.kind === 'received' && status.next >= chunkStart) {
						confirmed = status.next
						if (confirmed >= chunkEnd) {
							progress = status
							break
						}
						continue
					}
					progress = status
				}
				break
			}
			if (!progress) return { state: 'interrupted' }
			if (progress.kind === 'done') return { state: 'done', videoId: progress.videoId }
			if (progress.kind === 'gone') return { state: 'failed', code: 'session_expired' }
			if (progress.kind === 'error') {
				return progress.retryable
					? { state: 'interrupted' }
					: { state: 'failed', code: progress.code }
			}
			if (progress.next < chunkStart) return { state: 'failed', code: 'progress_mismatch' }
			confirmed = progress.next
			position = chunkEnd
			await request.onProgress(confirmed)
			if (confirmed < chunkEnd) {
				// Google kept less than we sent and the retries ran out: leave it to the next run.
				return { state: 'interrupted' }
			}
		}
	} catch {
		return { state: 'interrupted' }
	} finally {
		file.destroy()
	}
	// The stream ended. Google answers a finished upload on the last chunk; ask once more to be sure.
	const last = await query()
	if (last.kind === 'done') return { state: 'done', videoId: last.videoId }
	return { state: 'interrupted' }
}

const STATUS_FIELDS = [
	'embeddable',
	'license',
	'publicStatsViewable',
	'selfDeclaredMadeForKids',
	'containsSyntheticMedia',
] as const

/**
 * Changes who can watch an uploaded video. videos.update replaces the whole status part, so the
 * current settings are read first and carried over; only the privacy status and publish time change.
 * Only a private or unlisted video can be changed, and a schedule needs a private one.
 */
export async function publishVideo(request: {
	accessToken: string
	payload: PublishPayload
}): Promise<PublishResult> {
	const { accessToken, payload } = request
	let current: Response
	try {
		current = await fetch(`${API}/videos?part=status&id=${encodeURIComponent(payload.videoId)}`, {
			headers: authHeaders(accessToken),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch {
		return { ok: false, code: 'request_failed' }
	}
	if (!current.ok) return { ok: false, code: `http_${current.status}` }
	const found = (
		(await current.json().catch(() => null)) as {
			items?: Array<{ status?: Record<string, unknown> }>
		} | null
	)?.items?.[0]
	if (!found?.status) return { ok: false, code: 'video_not_found' }

	const was = found.status.privacyStatus
	if (payload.publishAt !== undefined && was !== 'private')
		return { ok: false, code: 'not_private' }
	if (was === 'public' || was === payload.privacyStatus) return { ok: false, code: 'already_set' }

	const status: Record<string, unknown> = { privacyStatus: payload.privacyStatus }
	for (const field of STATUS_FIELDS) {
		if (found.status[field] !== undefined) status[field] = found.status[field]
	}
	if (payload.publishAt !== undefined) status.publishAt = payload.publishAt

	try {
		const response = await fetch(`${API}/videos?part=status`, {
			method: 'PUT',
			headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: payload.videoId, status }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		return response.ok ? { ok: true } : { ok: false, code: `http_${response.status}` }
	} catch {
		return { ok: false, code: 'request_failed' }
	}
}
