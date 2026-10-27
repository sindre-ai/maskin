import type { Database } from '@maskin/db'
import { fileUploads, files } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { Cron } from 'croner'
import { and, eq, lt, or, sql } from 'drizzle-orm'
import { COMPLETE_CLAIM_TTL_MS, abortStoredUpload, deleteStoredObject } from '../lib/file-uploads'
import { logger } from '../lib/logger'

/**
 * Settles direct uploads nobody finished.
 *
 * Two kinds of row are left open:
 * - `pending` past `expires_at`: the browser never completed or aborted (tab
 *   closed, network lost). Its uploaded parts sit in the bucket, billed, and no
 *   request will ever come for them.
 * - `completing` past the claim TTL: a complete request took the upload and died
 *   (a deploy, a crash). Storage may or may not have stitched the object.
 *
 * For each: if the file row exists the upload did finish, so it is marked
 * completed; otherwise the multipart upload is aborted, any stitched object is
 * deleted and the row is marked aborted. A failure leaves the row as it was, so
 * the next tick retries it; nothing is dropped silently.
 *
 * Does not depend on a bucket lifecycle rule, which only covers incomplete
 * multipart uploads and not a stitched object.
 */
const CRON_EXPRESSION = '*/10 * * * *'
const BATCH_SIZE = 50

export class FileUploadReaperJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private storage: StorageProvider,
		private cronExpression: string = CRON_EXPRESSION,
	) {}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
	}

	stop(): void {
		if (this.job) {
			this.job.stop()
			this.job = null
		}
	}

	/** Returns the number of uploads settled. Never throws. */
	async tick(): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const claimCutoff = new Date(Date.now() - COMPLETE_CLAIM_TTL_MS)
			const stale = await this.db
				.select()
				.from(fileUploads)
				.where(
					or(
						and(eq(fileUploads.status, 'pending'), lt(fileUploads.expiresAt, sql`now()`)),
						and(eq(fileUploads.status, 'completing'), lt(fileUploads.claimedAt, claimCutoff)),
					),
				)
				.limit(BATCH_SIZE)

			let settled = 0
			for (const upload of stale) {
				if (await this.settle(upload)) settled++
			}
			if (stale.length > 0) {
				logger.info('File upload reaper tick', { found: stale.length, settled })
			}
			return settled
		} catch (err) {
			logger.error('File upload reaper tick failed', { error: String(err) })
			return 0
		} finally {
			this.running = false
		}
	}

	private async settle(upload: typeof fileUploads.$inferSelect): Promise<boolean> {
		try {
			const [file] = await this.db
				.select({ id: files.id })
				.from(files)
				.where(eq(files.id, upload.fileId))
				.limit(1)

			let next: 'completed' | 'aborted'
			if (file) {
				next = 'completed'
			} else {
				await abortStoredUpload(this.storage, upload)
				// Only a stitched object (a completing row) can exist under the key.
				if (upload.status === 'completing' && !(await deleteStoredObject(this.storage, upload))) {
					return false
				}
				next = 'aborted'
			}

			// Conditional on the status read above: a request that moved the row since
			// wins, and this one does nothing.
			await this.db
				.update(fileUploads)
				.set({ status: next })
				.where(and(eq(fileUploads.id, upload.id), eq(fileUploads.status, upload.status)))
			return true
		} catch (err) {
			logger.error('Failed to settle an abandoned file upload; will retry', {
				uploadId: upload.id,
				storageKey: upload.storageKey,
				error: String(err),
			})
			return false
		}
	}
}
