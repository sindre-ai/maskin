import { createHash } from 'node:crypto'
import { Readable, Transform, pipeline } from 'node:stream'
import type { StorageProvider } from '@maskin/storage'
import { capturePosthogEvent } from '../../../../analytics/posthog'
import { type DriveDownloadClient, createDefaultDriveDownloadClient } from '../download-client'
import { DriveError, isDriveError } from '../errors'
import {
	type DriveToolContext,
	GOOGLE_APPS_FOLDER_MIME,
	GOOGLE_APPS_SHORTCUT_MIME,
} from '../operations'
import { getGoogleDriveAccessToken } from '../token'

export const GET_FILE_BYTES_TOOL = 'google_drive__get_file_bytes'

/** Files at or above this size carry the informational LARGE_FILE_STREAMED_TO_STORAGE tag. */
export const LARGE_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024

const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.'

/** Default export type per Google-native type; any other native type needs an explicit exportMimeType. */
const DEFAULT_EXPORT_MIME: Record<string, string> = {
	'application/vnd.google-apps.document': 'application/pdf',
	'application/vnd.google-apps.presentation': 'application/pdf',
	'application/vnd.google-apps.spreadsheet': 'text/csv',
}

// Drive ids are url-safe base64-ish. The id ends up in a storage key, so refuse
// anything else rather than escape it.
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export interface GetFileBytesInput {
	fileId: string
	exportMimeType?: string
}

export interface GetFileBytesOutput {
	fileId: string
	name: string
	mimeType: string
	sizeBytes: number
	/** The storage key of the downloaded object, inside the caller's workspace prefix. */
	storageUrl: string
	sha256: string
	/** Informational, not an error: set for files streamed at or above the large-file threshold. */
	tag?: 'LARGE_FILE_STREAMED_TO_STORAGE'
}

export interface GetFileBytesContext extends DriveToolContext {
	storage?: StorageProvider
	/** Injection point for tests. Defaults to the real fetch-backed client. */
	downloadClient?: DriveDownloadClient
}

export const GET_FILE_BYTES_DESCRIPTION =
	'Download a Drive file into Maskin storage and return a handle, never the bytes. Returns {fileId, name, mimeType, sizeBytes, storageUrl, sha256}; storageUrl is a storage key inside this workspace (register it as a workspace file with create_file, or pass it to google_drive__write_file). Binary files stream straight to storage, so recordings and videos of several GB are fine; files of 100 MB or more also carry tag LARGE_FILE_STREAMED_TO_STORAGE, which is informational. Google Docs and Slides export to application/pdf and Sheets to text/csv unless exportMimeType says otherwise; other Google-native types (Drawings, Forms) need an exportMimeType or fail with EXPORT_FORMAT_UNSUPPORTED. exportMimeType is ignored for binary files. Downloading the same fileId again overwrites the stored object.'

export function downloadStorageKey(workspaceId: string, fileId: string): string {
	return `workspaces/${workspaceId}/integrations/google-drive/downloads/${fileId}`
}

/**
 * google_drive__get_file_bytes. Streams Drive's response body through a hashing
 * tap into storage.put, so the file is never held in this process: memory is
 * bounded by the upload's part buffers, not by the file size.
 */
export async function getFileBytes(
	ctx: GetFileBytesContext,
	input: GetFileBytesInput,
): Promise<GetFileBytesOutput> {
	if (!ctx.storage) {
		throw new DriveError({
			code: 'PROVIDER_ERROR',
			message: 'File storage is not available on this server.',
		})
	}
	if (!DRIVE_ID_PATTERN.test(input.fileId)) {
		throw new DriveError({
			code: 'INVALID_INPUT',
			message: 'fileId is not a valid Drive file id.',
			hint: 'Use the id field from google_drive__search_files or google_drive__list_folder.',
		})
	}

	const { accessToken } = await getGoogleDriveAccessToken(ctx.db, ctx.workspaceId, ctx.actorId)
	const client = ctx.downloadClient ?? createDefaultDriveDownloadClient()

	const meta = await client.getFileMetadata(accessToken, input.fileId)
	if (meta.trashed) {
		throw new DriveError({
			code: 'FILE_TRASHED',
			message: 'This Drive file is in the trash.',
			hint: 'Restore it in Drive first, or pick another file.',
		})
	}
	const exportMimeType = resolveExportMimeType(meta.mimeType, input.exportMimeType)

	let body: ReadableStream<Uint8Array>
	try {
		body = await client.openContent(accessToken, input.fileId, { exportMimeType })
	} catch (err) {
		// Google answers 400 when it cannot export the file to the requested type.
		if (exportMimeType && isDriveError(err) && err.providerStatus === 400) {
			throw new DriveError({
				code: 'EXPORT_FORMAT_UNSUPPORTED',
				message: `Drive cannot export this file as ${exportMimeType}.`,
				provider_status: 400,
				hint: 'Pick an export type Drive supports for this file type, for example application/pdf.',
			})
		}
		throw err
	}

	const storageUrl = downloadStorageKey(ctx.workspaceId, input.fileId)
	const tap = new HashingTap()
	const source = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>)
	try {
		// pipeline (not .pipe) so a failure on the Drive side destroys the tap, which
		// fails the upload and aborts the multipart upload instead of completing it.
		await ctx.storage.put(
			storageUrl,
			pipeline(source, tap, () => undefined),
		)
	} catch (err) {
		// Free the Drive connection even when the upload gave up without draining it.
		source.destroy()
		tap.destroy()
		const reason = err instanceof Error ? err.message : String(err)
		throw new DriveError({
			code: 'UPLOAD_FAILED',
			message: `Streaming the file into storage failed: ${reason}`.slice(0, 300),
			hint: 'Retry the call. If it keeps failing, the file may be too large for the storage backend.',
		})
	}

	const out: GetFileBytesOutput = {
		fileId: meta.id,
		name: meta.name,
		mimeType: exportMimeType ?? meta.mimeType,
		sizeBytes: tap.bytes,
		storageUrl,
		sha256: tap.digest(),
	}
	const large = tap.bytes >= LARGE_FILE_THRESHOLD_BYTES
	if (large) out.tag = 'LARGE_FILE_STREAMED_TO_STORAGE'

	// Best-effort; sizes and flags only, never the file name or id.
	void capturePosthogEvent('drive_file_downloaded', ctx.actorId, {
		provider: 'google-drive',
		workspace_id: ctx.workspaceId,
		actor_id: ctx.actorId,
		mime_type: out.mimeType,
		size_bytes: out.sizeBytes,
		exported: exportMimeType !== undefined,
		large_file: large,
	})
	return out
}

/** The export type to request, or undefined for a binary file (plain alt=media download). */
function resolveExportMimeType(fileMimeType: string, requested?: string): string | undefined {
	if (fileMimeType === GOOGLE_APPS_FOLDER_MIME || fileMimeType === GOOGLE_APPS_SHORTCUT_MIME) {
		throw new DriveError({
			code: 'INVALID_INPUT',
			message:
				fileMimeType === GOOGLE_APPS_FOLDER_MIME
					? 'Folders have no bytes to download.'
					: 'This is a Drive shortcut, not the file itself.',
			hint:
				fileMimeType === GOOGLE_APPS_FOLDER_MIME
					? 'Use google_drive__list_folder to see what is inside.'
					: 'Call again with the shortcutTargetId from google_drive__list_folder.',
		})
	}
	if (!fileMimeType.startsWith(GOOGLE_APPS_PREFIX)) return undefined
	const resolved = requested ?? DEFAULT_EXPORT_MIME[fileMimeType]
	if (!resolved) {
		throw new DriveError({
			code: 'EXPORT_FORMAT_UNSUPPORTED',
			message: `${fileMimeType} has no default export format.`,
			hint: 'Pass exportMimeType, for example application/pdf.',
		})
	}
	return resolved
}

/** Pass-through Transform that hashes and counts every byte as it streams by. */
class HashingTap extends Transform {
	bytes = 0
	private readonly hash = createHash('sha256')

	override _transform(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null, data?: Buffer) => void,
	): void {
		this.bytes += chunk.length
		this.hash.update(chunk)
		callback(null, chunk)
	}

	digest(): string {
		return this.hash.digest('hex')
	}
}
