import type { Database } from '@maskin/db'
import { Cron } from 'croner'
import { sql } from 'drizzle-orm'
import { rotateIntegrationDek } from '../lib/integrations/rotate-dek'
import { getKmsProvider } from '../lib/keychain-kms'
import { logger } from '../lib/logger'

/**
 * Nightly DEK rotation, the lazy half of master key rotation.
 *
 * Re-wraps every envelope credential that was read in the last 24 hours under a
 * fresh DEK and the current master key. Credentials nobody reads are
 * left alone: they keep decrypting under the old key, and are rotated the first
 * time they are used and the next night comes round. Legacy rows (no
 * dek_ciphertext) are never selected, so this can never upgrade one by accident;
 * the legacy upgrade job owns that, behind its flag.
 *
 * The key is only used when there is something to rotate. Rows are done one at a
 * time: one failing row is logged and the run goes on.
 */
const CRON_EXPRESSION = '23 4 * * *'

export interface DekRotationResult {
	candidates: number
	rotated: number
	/** Changed under us, or turned out not to be an envelope row. Retried tomorrow. */
	skipped: number
	failed: number
}

export class RotateDeksJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
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

	/** Swallowed-error wrapper for the scheduler. */
	async tick(): Promise<void> {
		try {
			await this.run()
		} catch (err) {
			logger.error('DEK rotation run failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	async run(): Promise<DekRotationResult> {
		const result: DekRotationResult = { candidates: 0, rotated: 0, skipped: 0, failed: 0 }
		if (this.running) return result
		this.running = true
		try {
			const rows = (await this.db.execute(sql`
				SELECT integrations.id::text AS id, integrations.workspace_id::text AS workspace_id
				FROM integrations
				WHERE integrations.dek_ciphertext IS NOT NULL
					AND EXISTS (
						SELECT 1 FROM credential_access_log
						WHERE credential_access_log.integration_id = integrations.id
							AND credential_access_log.action = 'read'
							AND credential_access_log.read_at > now() - interval '24 hours'
					)
				ORDER BY integrations.id
			`)) as unknown as Array<{ id: string; workspace_id: string }>
			result.candidates = rows.length
			if (rows.length === 0) return result

			const kms = getKmsProvider()
			for (const row of rows) {
				try {
					const outcome = await rotateIntegrationDek(this.db, kms, {
						integrationId: row.id,
						workspaceId: row.workspace_id,
						origin: 'nightly',
					})
					if (outcome === 'rotated') result.rotated++
					else result.skipped++
				} catch (err) {
					result.failed++
					logger.warn('DEK rotation failed for a row', {
						integrationId: row.id,
						error: err instanceof Error ? err.name : 'unknown',
					})
				}
			}
			logger.info('DEK rotation run', { ...result })
			return result
		} finally {
			this.running = false
		}
	}
}
