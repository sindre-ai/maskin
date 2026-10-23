import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { Cron } from 'croner'
import { and, asc, eq, gt, isNotNull, isNull, notInArray } from 'drizzle-orm'
import { decrypt, decryptEnvelope, encryptEnvelope } from '../lib/crypto'
import { getKmsProvider } from '../lib/keychain-kms'
import { logger } from '../lib/logger'

/**
 * Nightly upgrade of pre-Keychain credentials to envelope encryption.
 *
 * A legacy row has dek_ciphertext NULL and decrypts under INTEGRATION_ENCRYPTION_KEY.
 * This job decrypts it, re-encrypts the same plaintext under a fresh DEK wrapped by
 * the master key, and writes credentials and dek_ciphertext in one UPDATE. The
 * decrypted value never changes; the new envelope is read back before it is written.
 *
 * BUILT BUT OFF. It does nothing unless KEYCHAIN_LEGACY_UPGRADE_ENABLED is exactly
 * "true" (default unset = off). About 20 existing readers (integrations.ts,
 * token-manager.ts, Slack, GitHub, LinkedIn and others) call decrypt(row.credentials)
 * with the old key and throw on an envelope row, so enabling this before they
 * dual-read breaks them. "All credentials are envelope encrypted" is therefore NOT
 * true until the dual-read follow-on lands and the flag is flipped. The gate is
 * checked in run(), not only in the scheduler, so a manual run is gated too.
 *
 * Deny-list: even with the flag on, rows of the providers below are skipped. Their
 * refresh or reconnect paths still write the legacy form, and a legacy write into a
 * row that already has dek_ciphertext leaves a stale DEK next to legacy ciphertext,
 * which the next dual-read tries to unwrap as an envelope. Found by grep over the
 * writers on the bet branch; the follow-on moves those writers to the envelope
 * writer and then removes the list. Writers that sit in routes/integrations.ts
 * (api-key upsert) are not provider-specific, so the flag, not this list, is the
 * real gate.
 *
 * A concurrent legacy write between the read and the write is not overwritten: the
 * UPDATE only matches while credentials still equals what was read and
 * dek_ciphertext is still NULL.
 */
const CRON_EXPRESSION = '43 3 * * *'
const BATCH_SIZE = 100

export const LEGACY_UPGRADE_ENV = 'KEYCHAIN_LEGACY_UPGRADE_ENABLED'

export const LEGACY_UPGRADE_DENY_LIST = [
	'gmail',
	'google-calendar',
	'google-meet',
	'linear',
	'slack',
	'ubersuggest',
	'github',
	'linkedin-unipile',
]

export interface LegacyUpgradeResult {
	enabled: boolean
	upgraded: number
	/** The row changed under us (a concurrent write) or was already upgraded. */
	skipped: number
	failed: number
}

export function isLegacyUpgradeEnabled(env: Record<string, string | undefined> = process.env) {
	return env[LEGACY_UPGRADE_ENV]?.trim() === 'true'
}

export class UpgradeLegacyCredentialsJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private cronExpression: string = CRON_EXPRESSION,
		private batchSize: number = BATCH_SIZE,
		private isEnabled: () => boolean = () => isLegacyUpgradeEnabled(),
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
			logger.error('Legacy credential upgrade run failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	async run(): Promise<LegacyUpgradeResult> {
		const result: LegacyUpgradeResult = { enabled: false, upgraded: 0, skipped: 0, failed: 0 }
		if (!this.isEnabled()) {
			logger.info('Legacy credential upgrade skipped, gate off', { flag: LEGACY_UPGRADE_ENV })
			return result
		}
		if (this.running) return result
		this.running = true
		result.enabled = true
		try {
			const kms = getKmsProvider()
			let cursor: string | null = null
			for (;;) {
				const rows: Array<{
					id: string
					workspaceId: string
					credentials: string | null
				}> = await this.db
					.select({
						id: integrations.id,
						workspaceId: integrations.workspaceId,
						credentials: integrations.credentials,
					})
					.from(integrations)
					.where(
						and(
							isNull(integrations.dekCiphertext),
							isNotNull(integrations.credentials),
							notInArray(integrations.provider, LEGACY_UPGRADE_DENY_LIST),
							cursor ? gt(integrations.id, cursor) : undefined,
						),
					)
					.orderBy(asc(integrations.id))
					.limit(this.batchSize)
				if (rows.length === 0) break
				for (const row of rows) {
					if (row.credentials === null) continue
					try {
						const plaintext = decrypt(row.credentials)
						const envelope = await encryptEnvelope(kms, row.workspaceId, plaintext)
						// Read the envelope back before it replaces the only copy.
						const check = await decryptEnvelope(
							kms,
							row.workspaceId,
							envelope.credentials,
							envelope.dekCiphertext,
						)
						if (check !== plaintext) throw new Error('envelope read-back did not match')
						const updated = await this.db
							.update(integrations)
							.set({
								credentials: envelope.credentials,
								dekCiphertext: envelope.dekCiphertext,
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(integrations.id, row.id),
									isNull(integrations.dekCiphertext),
									eq(integrations.credentials, row.credentials),
								),
							)
							.returning({ id: integrations.id })
						if (updated.length === 0) result.skipped++
						else result.upgraded++
					} catch (err) {
						result.failed++
						logger.warn('Legacy credential upgrade failed for a row', {
							integrationId: row.id,
							error: err instanceof Error ? err.message : String(err),
						})
					}
				}
				cursor = rows[rows.length - 1]?.id ?? null
				if (rows.length < this.batchSize) break
			}
			logger.info('Legacy credential upgrade run', { ...result })
			return result
		} finally {
			this.running = false
		}
	}
}
