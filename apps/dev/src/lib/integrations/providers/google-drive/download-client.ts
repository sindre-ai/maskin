import { parseJson, requestWithRetry, sleep } from './client'

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'

/**
 * The two Drive calls google_drive__get_file_bytes needs. Kept apart from
 * DriveClient (list-shaped) so tools that only list do not have to fake these.
 * Same retry policy as DriveClient: 429 and 5xx back off, anything else throws a
 * classified DriveError. Retries only cover getting the response headers; once
 * the body starts flowing a failure surfaces on the stream.
 */
export interface DriveDownloadClient {
	getFileMetadata(accessToken: string, fileId: string): Promise<DriveFileMetadata>
	/** Open the bytes of a binary file (alt=media), or an export of a Google-native file. */
	openContent(
		accessToken: string,
		fileId: string,
		opts?: { exportMimeType?: string },
	): Promise<ReadableStream<Uint8Array>>
}

export interface DriveFileMetadata {
	id: string
	name: string
	mimeType: string
	/** Drive reports a size for binary files only, as a decimal string. */
	size?: string
	trashed?: boolean
}

const METADATA_FIELDS = 'id,name,mimeType,size,trashed'

export function createDefaultDriveDownloadClient(
	fetchImpl: typeof fetch = fetch,
	sleepImpl: (ms: number) => Promise<void> = sleep,
): DriveDownloadClient {
	return {
		async getFileMetadata(accessToken, fileId) {
			const qs = new URLSearchParams({ fields: METADATA_FIELDS, supportsAllDrives: 'true' })
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${qs.toString()}`,
				accessToken,
				'drive.files.get',
			)
			return (await parseJson<DriveFileMetadata>(res)) as DriveFileMetadata
		},

		async openContent(accessToken, fileId, opts) {
			const id = encodeURIComponent(fileId)
			const url = opts?.exportMimeType
				? `${DRIVE_API_BASE}/files/${id}/export?${new URLSearchParams({ mimeType: opts.exportMimeType }).toString()}`
				: `${DRIVE_API_BASE}/files/${id}?${new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' }).toString()}`
			const res = await requestWithRetry(
				fetchImpl,
				sleepImpl,
				url,
				accessToken,
				opts?.exportMimeType ? 'drive.files.export' : 'drive.files.get.media',
			)
			if (!res.body) {
				// Never buffer as a fallback: an empty file is the only body-less success.
				return new ReadableStream<Uint8Array>({ start: (c) => c.close() })
			}
			return res.body
		},
	}
}
