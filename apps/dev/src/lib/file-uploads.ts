import type { StorageProvider } from '@maskin/storage'
import { logger } from './logger'

/** How long a complete request may hold an upload before it is presumed dead. */
export const COMPLETE_CLAIM_TTL_MS = 15 * 60 * 1000

interface StoredUpload {
	id: string
	storageKey: string
	s3UploadId: string
}

function errorName(err: unknown): string | undefined {
	return (err as { name?: string } | null)?.name
}

/** Storage has no such multipart upload: it was aborted, expired or already stitched. */
export function isNoSuchUpload(err: unknown): boolean {
	return errorName(err) === 'NoSuchUpload'
}

export type CompleteFailure = 'bad_parts' | 'gone' | 'unavailable'

/**
 * Sorts a failed CompleteMultipartUpload by who can fix it. Wrong or missing
 * parts are the caller's to retry; a vanished upload will never succeed; anything
 * else (network, 5xx, credentials) is storage's problem, not a mistake in the
 * request, and must not be reported as one.
 */
export function classifyCompleteFailure(err: unknown): CompleteFailure {
	switch (errorName(err)) {
		case 'InvalidPart':
		case 'InvalidPartOrder':
		case 'EntityTooSmall':
		case 'MalformedXML':
			return 'bad_parts'
		case 'NoSuchUpload':
			return 'gone'
		default:
			return 'unavailable'
	}
}

/** Aborts the multipart upload in storage. Already gone counts as done; anything else throws. */
export async function abortStoredUpload(
	storage: StorageProvider,
	upload: StoredUpload,
): Promise<void> {
	try {
		await storage.abortMultipartUpload(upload.storageKey, upload.s3UploadId)
	} catch (err) {
		if (!isNoSuchUpload(err)) throw err
	}
}

/**
 * Deletes the stitched object of an upload that will never become a file.
 * Never throws: the caller is already on a failure path. A failed delete leaves a
 * billable orphan, so it is logged at error level with the key.
 */
export async function deleteStoredObject(
	storage: StorageProvider,
	upload: StoredUpload,
): Promise<boolean> {
	try {
		await storage.delete(upload.storageKey)
		return true
	} catch (err) {
		logger.error('Failed to delete the object of an abandoned upload (orphan left)', {
			uploadId: upload.id,
			storageKey: upload.storageKey,
			error: String(err),
		})
		return false
	}
}
