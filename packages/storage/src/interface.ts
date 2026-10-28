import type { Readable } from 'node:stream'

export interface PutOptions {
	/** Aborts a Buffer upload when fired (streamed uploads ignore it). */
	signal?: AbortSignal
}

export interface CompletedPart {
	partNumber: number
	/** The ETag the storage service returned for the part's PUT, quotes included. */
	etag: string
}

export interface PresignDownloadOptions {
	expiresInSeconds: number
	/** Sets Content-Type on the response so the browser handles the bytes correctly. */
	contentType?: string
	/** Sets Content-Disposition on the response (e.g. `attachment; filename="a.mp4"`). */
	contentDisposition?: string
}

export interface StorageProvider {
	put(key: string, data: Buffer | Uint8Array | Readable, options?: PutOptions): Promise<void>
	get(key: string): Promise<Buffer>
	list(prefix: string): Promise<string[]>
	listWithMetadata(prefix: string): Promise<{ key: string; size: number }[]>
	delete(key: string): Promise<void>
	exists(key: string): Promise<boolean>
	ensureBucket(): Promise<void>

	// -- Large objects: the browser talks to storage directly -----------------
	// The bytes never pass through the API. URLs point at the storage service's
	// browser-reachable address (S3_PUBLIC_ENDPOINT when set).

	/** Starts a multipart upload and returns its upload id. */
	createMultipartUpload(key: string, options: { contentType: string }): Promise<string>
	/** URL the browser PUTs one part (5 MiB to 5 GiB; part number 1 to 10000) to. */
	presignUploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		expiresInSeconds: number,
	): Promise<string>
	completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<void>
	/** Discards an unfinished upload and its uploaded parts. */
	abortMultipartUpload(key: string, uploadId: string): Promise<void>
	/** Size of the stored object, or null when it does not exist. */
	headObject(key: string): Promise<{ size: number } | null>
	presignDownload(key: string, options: PresignDownloadOptions): Promise<string>
}
