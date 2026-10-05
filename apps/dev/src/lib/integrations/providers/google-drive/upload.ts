import { randomUUID } from 'node:crypto'
import { DriveWriteError, RESTART_UPLOAD_HINT, classifyDriveApiError } from './write-errors'
import { DRIVE_UPLOAD_API, type DriveHttp } from './write-http'

/** Inline content below this size goes through a single multipart request. */
export const MULTIPART_MAX_BYTES = 5 * 1024 * 1024
/** Resumable chunk size. Must stay a multiple of 256 KiB (Drive requirement). */
export const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024
const MAX_CONSECUTIVE_FAILURES = 5
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 8_000

export const DRIVE_FILE_FIELDS = 'id,name,mimeType,webViewLink,version'

export interface DriveFileResource {
	id: string
	name: string
	mimeType: string
	webViewLink?: string
	version?: string
}

export interface UploadMetadata {
	name: string
	mimeType: string
	parentFolderId?: string
}

function fileMetadata(meta: UploadMetadata) {
	return {
		name: meta.name,
		mimeType: meta.mimeType,
		...(meta.parentFolderId && { parents: [meta.parentFolderId] }),
	}
}

function uploadFailed(message: string, providerStatus?: number): DriveWriteError {
	return new DriveWriteError({
		code: 'UPLOAD_FAILED',
		message,
		providerStatus,
		hint: RESTART_UPLOAD_HINT,
	})
}

async function parseFile(res: Response): Promise<DriveFileResource> {
	const file = (await res.json().catch(() => null)) as DriveFileResource | null
	if (!file?.id) {
		throw new DriveWriteError({
			code: 'PROVIDER_ERROR',
			message: 'Drive accepted the upload but returned no file resource.',
			providerStatus: res.status,
		})
	}
	return file
}

/** Single-request upload (metadata + media) for content under 5 MB. */
export async function multipartUpload(
	http: DriveHttp,
	meta: UploadMetadata,
	data: Buffer,
): Promise<DriveFileResource> {
	const boundary = `maskin-${randomUUID()}`
	const body = Buffer.concat([
		Buffer.from(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(fileMetadata(meta))}\r\n--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`,
		),
		data,
		Buffer.from(`\r\n--${boundary}--`),
	])
	const url = `${DRIVE_UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=${DRIVE_FILE_FIELDS}`
	let res: Response
	try {
		res = await http.fetchImpl(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${await http.getAccessToken()}`,
				'Content-Type': `multipart/related; boundary=${boundary}`,
			},
			body,
		})
	} catch (err) {
		throw new DriveWriteError({
			code: 'PROVIDER_ERROR',
			message: 'Network failure uploading to Drive.',
			providerStatus: 0,
		})
	}
	if (!res.ok)
		throw classifyDriveApiError(res.status, await res.text().catch(() => ''), res.headers)
	return parseFile(res)
}

/** Reads a byte source in exact-size chunks; only the last chunk may be short. */
class ChunkReader {
	private iterator: AsyncIterator<Uint8Array>
	private pending: Buffer[] = []
	private pendingBytes = 0
	private finished = false

	constructor(
		source: AsyncIterable<Uint8Array>,
		private chunkBytes: number,
	) {
		this.iterator = source[Symbol.asyncIterator]()
	}

	async next(): Promise<Buffer> {
		while (!this.finished && this.pendingBytes < this.chunkBytes) {
			const { value, done } = await this.iterator.next()
			if (done) {
				this.finished = true
				break
			}
			if (value.length === 0) continue
			this.pending.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
			this.pendingBytes += value.length
		}
		if (this.pendingBytes === 0) return Buffer.alloc(0)
		const all = Buffer.concat(this.pending)
		const chunk = all.subarray(0, this.chunkBytes)
		const rest = all.subarray(chunk.length)
		this.pending = rest.length > 0 ? [rest] : []
		this.pendingBytes = rest.length
		return chunk
	}
}

type ChunkOutcome =
	| { kind: 'complete'; file: DriveFileResource }
	| { kind: 'incomplete'; committed: number }
	| { kind: 'expired' }
	| { kind: 'transient' }

function committedBytes(res: Response): number {
	// "Range: bytes=0-N" means N+1 bytes are persisted; no header means none.
	const range = res.headers.get('range')
	const match = range ? /bytes=0-(\d+)/.exec(range) : null
	return match ? Number(match[1]) + 1 : 0
}

async function interpret(res: Response): Promise<ChunkOutcome> {
	if (res.status === 200 || res.status === 201)
		return { kind: 'complete', file: await parseFile(res) }
	if (res.status === 308) return { kind: 'incomplete', committed: committedBytes(res) }
	if (res.status === 404 || res.status === 410) return { kind: 'expired' }
	if (res.status === 429 || res.status >= 500) return { kind: 'transient' }
	throw classifyDriveApiError(res.status, await res.text().catch(() => ''), res.headers)
}

export interface ResumableParams {
	meta: UploadMetadata
	source: AsyncIterable<Uint8Array>
	/** Total byte length when the source knows it; otherwise Drive is told "*" until the last chunk. */
	totalSize?: number
	chunkBytes?: number
}

/**
 * Resumable upload in fixed-size chunks.
 *
 * Session state (URI, committed offset, the one unacknowledged chunk) lives in
 * this call's memory, per approved call 4. If the API process cycles or the
 * session cannot be resumed, the call fails with UPLOAD_FAILED and the agent
 * restarts the upload. An expired session URI is never retried.
 */
export async function resumableUpload(
	http: DriveHttp,
	params: ResumableParams,
): Promise<DriveFileResource> {
	const chunkBytes = params.chunkBytes ?? RESUMABLE_CHUNK_BYTES
	const reader = new ChunkReader(params.source, chunkBytes)

	let current = await reader.next()
	if (current.length === 0) {
		// Nothing to stream; Drive's resumable protocol has no clean empty-body form.
		return multipartUpload(http, params.meta, Buffer.alloc(0))
	}

	const sessionUri = await startSession(http, params.meta, params.totalSize)

	let offset = 0
	while (true) {
		const next = await reader.next()
		const isLast = next.length === 0
		const end = offset + current.length
		if (isLast && params.totalSize !== undefined && end !== params.totalSize) {
			throw uploadFailed(`The source ended at ${end} bytes but ${params.totalSize} were declared.`)
		}
		const total = isLast
			? String(end)
			: params.totalSize !== undefined
				? String(params.totalSize)
				: '*'
		const file = await sendChunk(http, sessionUri, current, offset, total)
		if (file) return file
		if (isLast) throw uploadFailed('Drive did not acknowledge the final chunk.')
		offset = end
		current = next
	}
}

async function startSession(
	http: DriveHttp,
	meta: UploadMetadata,
	totalSize: number | undefined,
): Promise<string> {
	const url = `${DRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=${DRIVE_FILE_FIELDS}`
	let res: Response
	try {
		res = await http.fetchImpl(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${await http.getAccessToken()}`,
				'Content-Type': 'application/json; charset=UTF-8',
				'X-Upload-Content-Type': meta.mimeType,
				...(totalSize !== undefined && { 'X-Upload-Content-Length': String(totalSize) }),
			},
			body: JSON.stringify(fileMetadata(meta)),
		})
	} catch (err) {
		throw uploadFailed('Network failure starting the resumable upload.', 0)
	}
	if (!res.ok)
		throw classifyDriveApiError(res.status, await res.text().catch(() => ''), res.headers)
	const location = res.headers.get('location')
	if (!location) throw uploadFailed('Drive did not return a resumable session URI.', res.status)
	return location
}

/**
 * Sends one chunk and returns the finished file, or null once Drive has
 * committed every byte of the chunk. On a dropped connection or 5xx it asks
 * Drive how far it got and resumes from the last committed byte.
 */
async function sendChunk(
	http: DriveHttp,
	sessionUri: string,
	chunk: Buffer,
	offset: number,
	total: string,
): Promise<DriveFileResource | null> {
	const end = offset + chunk.length
	let pos = offset
	let failures = 0

	const put = async (headers: Record<string, string>, body?: Buffer): Promise<ChunkOutcome> => {
		try {
			const res = await http.fetchImpl(sessionUri, {
				method: 'PUT',
				headers: { Authorization: `Bearer ${await http.getAccessToken()}`, ...headers },
				body: body as BodyInit | undefined,
				redirect: 'manual',
			})
			return await interpret(res)
		} catch (err) {
			if (err instanceof DriveWriteError) throw err
			return { kind: 'transient' }
		}
	}
	const sendFrom = (from: number) =>
		put({ 'Content-Range': `bytes ${from}-${end - 1}/${total}` }, chunk.subarray(from - offset))
	const queryStatus = () => put({ 'Content-Range': `bytes */${total}`, 'Content-Length': '0' })

	let outcome = await sendFrom(pos)
	while (true) {
		if (outcome.kind === 'complete') return outcome.file
		if (outcome.kind === 'expired') {
			throw uploadFailed('The resumable upload session expired. A fresh session is required.', 404)
		}
		if (outcome.kind === 'transient') {
			failures++
			if (failures > MAX_CONSECUTIVE_FAILURES) {
				throw uploadFailed(
					`The upload kept failing after ${MAX_CONSECUTIVE_FAILURES} resume attempts.`,
				)
			}
			await http.sleep(Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS))
			outcome = await queryStatus()
			continue
		}
		// incomplete: Drive reports how many bytes of the whole file it holds.
		if (outcome.committed >= end) return null
		if (outcome.committed < offset) {
			throw uploadFailed('Drive reports fewer bytes than were already acknowledged.')
		}
		if (outcome.committed > pos) {
			failures = 0
		} else {
			// No forward progress: spend retry budget so a stalled session cannot spin.
			failures++
			if (failures > MAX_CONSECUTIVE_FAILURES) {
				throw uploadFailed(
					`The upload made no progress after ${MAX_CONSECUTIVE_FAILURES} resume attempts.`,
				)
			}
			await http.sleep(Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS))
		}
		pos = outcome.committed
		outcome = await sendFrom(pos)
	}
}
