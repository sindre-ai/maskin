import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { files } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { sha256Hex } from '../lib/file-save'
import { fileStorageKey, fileViewerUrl, frontendBaseUrl } from '../lib/file-urls'
import { logger } from '../lib/logger'

/** How much of the transcript the transcribe response carries beside the saved file. */
export const TRANSCRIPT_PREVIEW_CHARS = 1000

const FILE_NAME_MAX = 200

/** First part of a transcript, cut on a word boundary where there is one. */
export function transcriptPreview(text: string): string {
	if (text.length <= TRANSCRIPT_PREVIEW_CHARS) return text
	const cut = text.slice(0, TRANSCRIPT_PREVIEW_CHARS)
	const lastSpace = cut.lastIndexOf(' ')
	return `${(lastSpace > TRANSCRIPT_PREVIEW_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** "standup.mp4" -> "standup transcript.txt" */
export function transcriptFileName(sourceName: string): string {
	const base = sourceName.replace(/\.[^./\\]{1,8}$/, '').trim() || 'recording'
	return `${base.slice(0, FILE_NAME_MAX - '  transcript.txt'.length)} transcript.txt`
}

export interface SavedTranscript {
	fileId: string
	name: string
	url: string
}

/**
 * Stores a transcript as a workspace file next to the recording it came from.
 * Same order as `POST /api/files`: row, then bytes, then the audit event, with
 * the row removed again if the bytes cannot be written.
 *
 * Returns null instead of throwing: by now the audio has been transcribed and
 * paid for, so the caller still owes the person the text.
 */
export async function saveTranscriptFile(params: {
	db: Database
	storage: StorageProvider
	workspaceId: string
	actorId: string
	sessionId?: string
	sourceName: string
	text: string
}): Promise<SavedTranscript | null> {
	const { db, storage, workspaceId, actorId, sessionId, sourceName, text } = params
	const fileId = randomUUID()
	const storageKey = fileStorageKey(workspaceId, fileId)
	const bytes = Buffer.from(text, 'utf8')
	const name = transcriptFileName(sourceName)

	let url: string
	try {
		url = fileViewerUrl(frontendBaseUrl(), workspaceId, fileId)
	} catch (err) {
		logger.error('Cannot mint transcript file URL', { workspaceId, error: String(err) })
		return null
	}

	try {
		const [created] = await db
			.insert(files)
			.values({
				id: fileId,
				workspaceId,
				name,
				description: `Transcript of ${sourceName}`,
				tags: ['transcript'],
				mimeType: 'text/plain',
				sizeBytes: bytes.byteLength,
				storageKey,
				contentHash: sha256Hex(bytes),
				createdBy: actorId,
			})
			.returning()
		if (!created) throw new Error('insert returned no row')

		try {
			await storage.put(storageKey, bytes)
		} catch (err) {
			await db
				.delete(files)
				.where(eq(files.id, fileId))
				.catch((cleanupErr) =>
					logger.error('Failed to delete transcript file row after S3 put failure', {
						fileId,
						error: String(cleanupErr),
					}),
				)
			throw err
		}

		try {
			await recordEvent(db, {
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'file',
				entityId: fileId,
				data: { id: fileId, name, mimeType: 'text/plain', sizeBytes: bytes.byteLength },
				provenance: { sessionId, entityKind: 'file' },
			})
		} catch (err) {
			logger.error('Failed to record transcript file created audit event', {
				workspaceId,
				fileId,
				error: String(err),
			})
		}
		return { fileId, name, url }
	} catch (err) {
		logger.error('Failed to save transcript file; returning the text inline', {
			workspaceId,
			error: String(err),
		})
		return null
	}
}
