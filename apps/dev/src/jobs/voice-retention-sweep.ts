import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { Cron } from 'croner'
import { and, eq, ne, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import {
	DELETED_BY_REQUEST,
	RETENTION_MONTHS,
	deleteVoiceBlobs,
} from '../lib/outreach/voice/recordings'

/**
 * Daily sweep for call recordings and transcripts (voice-outreach/<contact_id>/ in S3).
 *
 *   1. Expiry: a contact whose retention_expires_at (default: voice_last_touch_at plus
 *      24 months) has passed loses its blobs, and last_call_recording_id and
 *      last_call_transcript_id are cleared.
 *   2. Erasure: a contact whose stored status is deleted_by_request loses its blobs, its
 *      content, and every metadata key except consent_*; erased_at marks it done.
 *
 * Consent evidence is not on this clock. Nothing here reads or writes the events table
 * except to add an audit row, and consent_* fields are never removed on expiry. Erasure
 * keeps consent_* too, pending the CTO's call on what proof survives an erasure request.
 *
 * Same shape as purge-idempotency.ts: a cron expression, no overlapping runs, a tick that
 * logs and never throws. One contact failing does not stop the others.
 */
const CRON_EXPRESSION = '41 3 * * *'

/**
 * VOICE_RETENTION_SWEEP_CRON overrides the schedule so E2E can observe a sweep within
 * seconds (croner accepts a leading seconds field). Unset, blank or unparseable falls
 * back to the daily default, so a typo cannot stop the sweep from running.
 */
export function resolveSweepCron(raw: string | undefined): string {
	const candidate = raw?.trim()
	if (!candidate) return CRON_EXPRESSION
	try {
		new Cron(candidate, { timezone: 'UTC', paused: true }).stop()
		return candidate
	} catch {
		logger.warn('VOICE_RETENTION_SWEEP_CRON is not a valid cron expression, using the default', {
			value: candidate,
		})
		return CRON_EXPRESSION
	}
}

const KEPT_ON_ERASURE = /^consent_/

export class VoiceRetentionSweepJob {
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

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			await processVoiceRetentionSweep(this.db, this.storage)
		} finally {
			this.running = false
		}
	}
}

export interface VoiceRetentionSweepResult {
	expired: number
	erased: number
}

export async function processVoiceRetentionSweep(
	db: Database,
	storage: StorageProvider,
	now: Date = new Date(),
): Promise<VoiceRetentionSweepResult> {
	const result = { expired: 0, erased: 0 }
	try {
		result.erased = await sweepErased(db, storage)
	} catch (err) {
		logger.error('voice retention sweepErased failed', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
	try {
		result.expired = await sweepExpired(db, storage, now)
	} catch (err) {
		logger.error('voice retention sweepExpired failed', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
	if (result.expired > 0 || result.erased > 0) logger.info('voice retention sweep tick', result)
	return result
}

export async function sweepExpired(
	db: Database,
	storage: StorageProvider,
	now: Date,
): Promise<number> {
	const due = await db
		.select({
			id: objects.id,
			workspaceId: objects.workspaceId,
			driver: objects.driver,
			createdBy: objects.createdBy,
		})
		.from(objects)
		.where(
			and(
				eq(objects.type, 'contact'),
				ne(objects.status, DELETED_BY_REQUEST),
				sql`(${objects.metadata}->>'last_call_recording_id' is not null
					or ${objects.metadata}->>'last_call_transcript_id' is not null)`,
				sql`coalesce(
					nullif(${objects.metadata}->>'retention_expires_at', '')::timestamptz,
					nullif(${objects.metadata}->>'voice_last_touch_at', '')::timestamptz + ${sql.raw(`interval '${RETENTION_MONTHS} months'`)}
				) < ${now.toISOString()}::timestamptz`,
			),
		)

	let expired = 0
	for (const row of due) {
		try {
			const deleted = await deleteVoiceBlobs(storage, row.id)
			await db
				.update(objects)
				.set({
					metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb) - 'last_call_recording_id' - 'last_call_transcript_id'`,
					updatedAt: new Date(),
				})
				.where(eq(objects.id, row.id))
			await recordEvent(db, {
				workspaceId: row.workspaceId,
				actorId: row.driver ?? row.createdBy,
				action: 'updated',
				entityType: 'object',
				entityId: row.id,
				data: {
					source: 'voice_retention_sweep',
					reason: 'retention_expired',
					blobs_deleted: deleted,
				},
			})
			expired++
		} catch (err) {
			logger.error('voice retention expiry for contact failed', {
				contactId: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
	return expired
}

export async function sweepErased(db: Database, storage: StorageProvider): Promise<number> {
	const pending = await db
		.select({
			id: objects.id,
			workspaceId: objects.workspaceId,
			driver: objects.driver,
			createdBy: objects.createdBy,
			metadata: objects.metadata,
		})
		.from(objects)
		.where(
			and(
				eq(objects.type, 'contact'),
				eq(objects.status, DELETED_BY_REQUEST),
				sql`${objects.metadata}->>'erased_at' is null`,
			),
		)

	let erased = 0
	for (const row of pending) {
		try {
			// Blobs first: if S3 fails the row keeps its marker-free state and the next tick retries.
			const deleted = await deleteVoiceBlobs(storage, row.id)
			const kept = Object.fromEntries(
				Object.entries((row.metadata ?? {}) as Record<string, unknown>).filter(([key]) =>
					KEPT_ON_ERASURE.test(key),
				),
			)
			const updated = await db
				.update(objects)
				.set({
					content: null,
					metadata: { ...kept, erased_at: new Date().toISOString() },
					updatedAt: new Date(),
				})
				.where(and(eq(objects.id, row.id), eq(objects.status, DELETED_BY_REQUEST)))
				.returning({ id: objects.id })
			if (updated.length === 0) continue
			await recordEvent(db, {
				workspaceId: row.workspaceId,
				actorId: row.driver ?? row.createdBy,
				action: 'updated',
				entityType: 'object',
				entityId: row.id,
				data: { source: 'voice_retention_sweep', reason: 'erasure', blobs_deleted: deleted },
			})
			erased++
		} catch (err) {
			logger.error('voice erasure for contact failed', {
				contactId: row.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
	return erased
}
