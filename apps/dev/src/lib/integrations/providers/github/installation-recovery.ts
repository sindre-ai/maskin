import type { Database } from '@maskin/db'
import { events, integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { decrypt, encrypt } from '../../../crypto'
import { logger } from '../../../logger'
import type { StoredCredentials } from '../../types'

export interface PersistRecoveredInstallationIdInput {
	integrationId: string
	workspaceId: string
	actorId: string
	/** The installation id the caller believed was cached when it minted a fresh
	 *  token. If a concurrent recovery already rotated the row past this value,
	 *  the write short-circuits. */
	expectedOldInstallationId: string
	/** The install id discovery returned; overwrites the cached one on success. */
	newInstallationId: string
	/** owner/name — recorded on the audit event so ops can grep by repo. */
	repo: string
}

export interface PersistRecoveredInstallationIdResult {
	/** True when this caller wrote the new installation id + audit row. False
	 *  when a concurrent recovery had already rotated the row (the guarded
	 *  re-read observed the already-rotated value under the lock). */
	persisted: boolean
}

/**
 * Guarded persistence of an install-id rotation on the mint-on-write recovery
 * path. Runs `SELECT credentials … FOR UPDATE` inside a transaction so two
 * concurrent callers that both 404'd on the same cached id and both rediscovered
 * the same new id can't both insert an `installation_id_recovered` audit row —
 * the second caller blocks on the first's row lock, then re-reads the rotated
 * value and short-circuits. Under READ COMMITTED the older application-code-only
 * guard could pass both callers on the same stale snapshot; the row lock closes
 * that gap.
 *
 * Blast radius of the guard-miss is small (extra audit row, not data corruption)
 * but the recovery flag stays off until this is in place.
 */
export async function persistRecoveredInstallationId(
	db: Database,
	input: PersistRecoveredInstallationIdInput,
): Promise<PersistRecoveredInstallationIdResult> {
	const {
		integrationId,
		workspaceId,
		actorId,
		expectedOldInstallationId,
		newInstallationId,
		repo,
	} = input

	return await db.transaction(async (tx) => {
		const [current] = await tx
			.select({ credentials: integrations.credentials })
			.from(integrations)
			.where(eq(integrations.id, integrationId))
			.for('update')
			.limit(1)
		if (!current) return { persisted: false }

		const currentCreds: StoredCredentials = JSON.parse(decrypt(current.credentials))
		if (currentCreds.installation_id !== expectedOldInstallationId) {
			return { persisted: false }
		}

		const updated: StoredCredentials = {
			...currentCreds,
			installation_id: newInstallationId,
		}
		await tx
			.update(integrations)
			.set({ credentials: encrypt(JSON.stringify(updated)), updatedAt: new Date() })
			.where(eq(integrations.id, integrationId))

		try {
			await tx.insert(events).values({
				workspaceId,
				actorId,
				action: 'updated',
				entityType: 'integration',
				entityId: integrationId,
				data: {
					reason: 'installation_id_recovered',
					old_installation_id: expectedOldInstallationId,
					new_installation_id: newInstallationId,
					repo,
				},
			})
		} catch (auditErr) {
			logger.warn('Failed to insert installation_id_recovered audit event', {
				integrationId,
				error: String(auditErr),
			})
		}
		return { persisted: true }
	})
}
