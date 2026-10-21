import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { files } from '@maskin/db/schema'
import type { FileAnnotation } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { logger } from './logger'

/** How long a save waits for the row lock before giving up with a retryable error. */
export const FILE_LOCK_TIMEOUT_MS = 5_000
/** How long one storage call (read old bytes, upload, restore) may take under the lock. */
export const FILE_UPLOAD_TIMEOUT_MS = 10_000

type FileRow = typeof files.$inferSelect

export function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex')
}

/** The caller's if_match no longer matches the stored hash. Nothing was written. */
export class FileVersionConflictError extends Error {
	constructor(readonly currentHash: string) {
		super('File changed since it was loaded')
		this.name = 'FileVersionConflictError'
	}
}

/** The row lock or a storage call took too long. The save was rolled back; retrying is safe. */
export class FileSaveTimeoutError extends Error {
	constructor(readonly stage: 'lock' | 'storage') {
		super(
			stage === 'lock'
				? 'Timed out waiting for the file to be free'
				: 'Timed out talking to file storage',
		)
		this.name = 'FileSaveTimeoutError'
	}
}

// SQLSTATE 55P03 = lock_not_available, raised when lock_timeout expires.
function isLockTimeout(err: unknown): boolean {
	for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
		if (typeof e === 'object' && (e as { code?: unknown }).code === '55P03') return true
		e = e instanceof Error ? e.cause : undefined
	}
	return false
}

/**
 * Runs a storage call with a deadline. On timeout the signal is aborted so the
 * client drops the request, and the caller gets a FileSaveTimeoutError.
 */
async function withStorageTimeout<T>(
	ms: number,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(new FileSaveTimeoutError('storage'))
		}, ms)
	})
	const call = run(controller.signal)
	// The call may settle after the deadline won the race; keep that from
	// surfacing as an unhandled rejection.
	call.catch(() => {})
	try {
		return await Promise.race([call, deadline])
	} finally {
		clearTimeout(timer)
	}
}

export interface SaveFileInput {
	fileId: string
	/** Hash the caller last read. Omitted = last write wins. */
	ifMatch?: string
	/** New bytes, or null for a metadata-only update. */
	newBytes: Buffer | null
	name?: string
	description?: string | null
	kind?: string | null
	mimeType?: string
	annotations?: FileAnnotation[]
}

export interface SaveFileResult {
	row: FileRow
	/** True when new bytes were written and their hash differs from the hash before the save. */
	contentChanged: boolean
}

export interface SaveFileDeps {
	db: Database
	storage: StorageProvider
	lockTimeoutMs?: number
	uploadTimeoutMs?: number
}

/**
 * Saves a file under the row lock, so a stale editor copy cannot overwrite a
 * newer one.
 *
 *  1. Take the row lock (bounded by a lock timeout).
 *  2. Compare if_match with the stored hash. Mismatch: roll back, write nothing.
 *  3. Read the old bytes, then upload the new bytes while still holding the lock.
 *  4. Update the row and hash, then commit.
 *
 * If the upload fails the transaction rolls back and storage is untouched. If
 * the upload succeeded and the commit (or the row update) then fails, the old
 * bytes are put back before the error is returned. A failed restore is logged at
 * error level and the original error is returned; there is no retry loop.
 *
 * Returns null when the file does not exist.
 */
export async function saveFile(
	deps: SaveFileDeps,
	input: SaveFileInput,
): Promise<SaveFileResult | null> {
	const { db, storage } = deps
	const lockTimeoutMs = deps.lockTimeoutMs ?? FILE_LOCK_TIMEOUT_MS
	const uploadTimeoutMs = deps.uploadTimeoutMs ?? FILE_UPLOAD_TIMEOUT_MS

	// Set once the new bytes are in storage, so a later failure knows what to undo.
	// A holder object because TypeScript does not track assignments made inside
	// the transaction callback.
	const state: { uploaded: { row: FileRow; oldBytes: Buffer; storedHash: string } | null } = {
		uploaded: null,
	}

	try {
		return await db.transaction(async (tx) => {
			await tx.execute(sql`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`)

			const [locked] = await tx
				.select()
				.from(files)
				.where(eq(files.id, input.fileId))
				.for('update')
				.limit(1)
			if (!locked) return null

			// The old bytes are needed to restore after a failed commit, and to hash
			// a row that predates the content_hash column.
			const needOldBytes =
				input.newBytes !== null || (input.ifMatch !== undefined && !locked.contentHash)
			let oldBytes: Buffer | null = null
			let storedHash = locked.contentHash || null
			if (needOldBytes) {
				oldBytes = await withStorageTimeout(uploadTimeoutMs, () => storage.get(locked.storageKey))
				storedHash ??= sha256Hex(oldBytes)
			}

			if (input.ifMatch !== undefined && storedHash !== input.ifMatch) {
				throw new FileVersionConflictError(storedHash as string)
			}

			let contentHash = storedHash
			let sizeBytes = locked.sizeBytes
			if (input.newBytes && oldBytes && storedHash) {
				const newBytes = input.newBytes
				await withStorageTimeout(uploadTimeoutMs, (signal) =>
					storage.put(locked.storageKey, newBytes, { signal }),
				)
				state.uploaded = { row: locked, oldBytes, storedHash }
				contentHash = sha256Hex(newBytes)
				sizeBytes = newBytes.byteLength
			}

			const [row] = await tx
				.update(files)
				.set({
					name: input.name ?? locked.name,
					description: input.description !== undefined ? input.description : locked.description,
					kind: input.kind !== undefined ? input.kind : locked.kind,
					mimeType: input.mimeType ?? locked.mimeType,
					annotations: input.annotations ?? locked.annotations,
					sizeBytes,
					contentHash,
					updatedAt: new Date(),
				})
				.where(eq(files.id, input.fileId))
				.returning()
			if (!row) return null

			return {
				row,
				contentChanged: input.newBytes !== null && contentHash !== storedHash,
			}
		})
	} catch (err) {
		if (state.uploaded) {
			await restoreOldBytes(storage, state.uploaded, uploadTimeoutMs)
		}
		if (isLockTimeout(err)) throw new FileSaveTimeoutError('lock')
		throw err
	}
}

async function restoreOldBytes(
	storage: StorageProvider,
	{ row, oldBytes, storedHash }: { row: FileRow; oldBytes: Buffer; storedHash: string },
	uploadTimeoutMs: number,
): Promise<void> {
	try {
		await withStorageTimeout(uploadTimeoutMs, (signal) =>
			storage.put(row.storageKey, oldBytes, { signal }),
		)
	} catch (restoreErr) {
		logger.error('File restore failed after a failed save; storage holds bytes the row does not', {
			fileId: row.id,
			workspaceId: row.workspaceId,
			storedHash,
			error: String(restoreErr),
		})
	}
}

/**
 * Returns the row's content hash, computing it from the bytes just read when
 * the row predates the column, and writing it back (best effort, only while
 * still null). A read must not fail because the write-back did.
 */
export async function ensureContentHash(
	db: Database,
	row: FileRow,
	bytes: Buffer,
): Promise<string> {
	if (row.contentHash) return row.contentHash
	const hash = sha256Hex(bytes)
	try {
		await db
			.update(files)
			.set({ contentHash: hash })
			.where(and(eq(files.id, row.id), isNull(files.contentHash)))
	} catch (err) {
		logger.warn('Failed to write back content hash for legacy file row', {
			fileId: row.id,
			error: String(err),
		})
	}
	return hash
}
