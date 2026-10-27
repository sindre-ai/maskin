import { MAX_LARGE_FILE_SIZE_BYTES, maxFileSizeBytesFor } from '@maskin/shared'
import { type FileDetail, api } from './api'
import { readFileAsBase64 } from './file-utils'

/** What the uploader hands to `useUploadFile`: a file to send in parts, straight to storage. */
export interface LargeFileUpload {
	file: File
}

export interface UploadOptions {
	onProgress?: (progress: number) => void
	signal?: AbortSignal
}

/** Parts in flight at once. Each is one XHR of up to part_size bytes read lazily from the File. */
const PART_CONCURRENCY = 3
const PART_ATTEMPTS = 3

/** The type the upload is stored under; the JSON route and the direct upload must agree on it. */
function uploadMimeType(file: File): string {
	return file.type || 'application/octet-stream'
}

/**
 * True when the JSON route would refuse this file, so it goes straight to storage.
 * That cap depends on the type (video gets more than the rest), so the check has to
 * use the same one: a plain size threshold sent a 30 MB PDF down the JSON path to
 * be rejected.
 */
export function isLargeFile(file: File): boolean {
	return file.size > maxFileSizeBytesFor(uploadMimeType(file))
}

export function assertUploadable(file: File): void {
	if (file.size > MAX_LARGE_FILE_SIZE_BYTES) {
		throw new Error(
			`${file.name} is too large. The limit is ${MAX_LARGE_FILE_SIZE_BYTES / 1024 ** 3} GB.`,
		)
	}
}

/**
 * Turns a picked file into what `useUploadFile` takes. Files the JSON path can
 * carry are read as base64 as before; larger ones are passed through as a File,
 * so their bytes are never read into memory here.
 */
export async function toUploadInput(
	file: File,
): Promise<
	{ name: string; mime_type: string; content: string; encoding: 'base64' } | LargeFileUpload
> {
	assertUploadable(file)
	if (isLargeFile(file)) return { file }
	return {
		name: file.name,
		mime_type: uploadMimeType(file),
		content: await readFileAsBase64(file),
		encoding: 'base64',
	}
}

function abortError(): Error {
	return new Error('Upload aborted')
}

/** PUTs one part to its presigned URL and returns the ETag storage answered with. */
function putPart(
	url: string,
	blob: Blob,
	onBytes: (loaded: number) => void,
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest()
		xhr.open('PUT', url, true)
		xhr.upload.onprogress = (e) => onBytes(e.loaded)
		xhr.onload = () => {
			if (xhr.status < 200 || xhr.status >= 300) {
				reject(new Error(`Storage rejected a part (${xhr.status})`))
				return
			}
			// Needs the bucket's CORS rule to expose ETag; without it the header
			// is invisible to the page and the upload cannot be completed.
			const etag = xhr.getResponseHeader('ETag')
			if (!etag) reject(new Error('Storage did not return an ETag. Check the bucket CORS rule.'))
			else resolve(etag)
		}
		xhr.onerror = () => reject(new Error('Network error while uploading'))
		xhr.onabort = () => reject(abortError())
		if (signal) {
			if (signal.aborted) {
				reject(abortError())
				return
			}
			signal.addEventListener('abort', () => xhr.abort(), { once: true })
		}
		xhr.send(blob)
	})
}

async function putPartWithRetry(
	url: string,
	blob: Blob,
	onBytes: (loaded: number) => void,
	signal?: AbortSignal,
): Promise<string> {
	let lastError: unknown
	for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
		try {
			return await putPart(url, blob, onBytes, signal)
		} catch (err) {
			lastError = err
			if (signal?.aborted) throw abortError()
			onBytes(0)
			if (attempt < PART_ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt))
		}
	}
	throw lastError
}

/**
 * Uploads a file of any size up to the server's limit straight to storage:
 * ask the API for presigned part URLs, PUT the parts, then have the API stitch
 * and verify them. Only one part's worth of bytes is in flight per request, and
 * `File.slice` reads lazily, so memory stays flat however large the file is.
 *
 * Abandoning (abort or failure) tells the API to discard the parts already
 * stored, best effort.
 */
export async function uploadLargeFile(
	workspaceId: string,
	file: File,
	opts?: UploadOptions,
): Promise<FileDetail> {
	assertUploadable(file)
	const session = await api.files.startUpload(workspaceId, {
		name: file.name,
		mime_type: uploadMimeType(file),
		size_bytes: file.size,
	})

	const loadedByPart = new Map<number, number>()
	const report = () => {
		let loaded = 0
		for (const n of loadedByPart.values()) loaded += n
		opts?.onProgress?.(Math.min(loaded / file.size, 1))
	}

	const etags: { part_number: number; etag: string }[] = []
	const queue = [...session.parts]
	// One failing part cancels its siblings instead of letting them upload on.
	const stop = new AbortController()
	const onAbort = () => stop.abort()
	opts?.signal?.addEventListener('abort', onAbort, { once: true })
	if (opts?.signal?.aborted) stop.abort()

	const worker = async () => {
		for (let part = queue.shift(); part; part = queue.shift()) {
			const start = (part.part_number - 1) * session.part_size
			const blob = file.slice(start, Math.min(start + session.part_size, file.size))
			const etag = await putPartWithRetry(
				part.url,
				blob,
				(loaded) => {
					loadedByPart.set(part.part_number, loaded)
					report()
				},
				stop.signal,
			)
			loadedByPart.set(part.part_number, blob.size)
			report()
			etags.push({ part_number: part.part_number, etag })
		}
	}

	try {
		await Promise.all(
			Array.from({ length: Math.min(PART_CONCURRENCY, session.parts.length) }, () =>
				worker().catch((err) => {
					stop.abort()
					throw err
				}),
			),
		)
		return await api.files.completeUpload(workspaceId, session.upload_id, etags)
	} catch (err) {
		await api.files.abortUpload(workspaceId, session.upload_id).catch(() => {})
		throw err
	} finally {
		opts?.signal?.removeEventListener('abort', onAbort)
	}
}
