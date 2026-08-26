import type { Database } from '@maskin/db'
import { events, integrations } from '@maskin/db/schema'
import { and, eq, ne } from 'drizzle-orm'
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

/**
 * Propagate a recovered installation id to every *other* workspace bound to the
 * same installation. One GitHub App installation can be linked into several
 * workspaces (see `POST /api/integrations/github/link`); when a reinstall
 * rotates the id, only the row that happened to mint the token gets rotated by
 * `persistRecoveredInstallationId`. Without this the siblings each carry a dead
 * id until they independently 404 and recover, which for a workspace that only
 * reads webhooks may be never.
 *
 * Keyed on `external_id`, which the recovery path deliberately leaves at the old
 * value — webhook routing matches on it, and GitHub keeps delivering under the
 * id its payloads carry. Best-effort: failures are logged, never thrown, so a
 * sibling write can't fail an already-successful token mint.
 */
export async function propagateRecoveredInstallationId(
	db: Database,
	input: {
		/** The row already rotated by persistRecoveredInstallationId — skipped. */
		sourceIntegrationId: string
		actorId: string
		expectedOldInstallationId: string
		newInstallationId: string
		repo: string
	},
): Promise<{ updatedIntegrationIds: string[] }> {
	const { sourceIntegrationId, actorId, expectedOldInstallationId, newInstallationId, repo } = input

	const siblings = await db
		.select({
			id: integrations.id,
			workspaceId: integrations.workspaceId,
			credentials: integrations.credentials,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, 'github'),
				eq(integrations.externalId, expectedOldInstallationId),
				eq(integrations.status, 'active'),
				ne(integrations.id, sourceIntegrationId),
			),
		)

	const updatedIntegrationIds: string[] = []
	for (const sibling of siblings) {
		try {
			const creds: StoredCredentials = JSON.parse(decrypt(sibling.credentials))
			if (creds.installation_id !== expectedOldInstallationId) continue

			await db
				.update(integrations)
				.set({
					credentials: encrypt(JSON.stringify({ ...creds, installation_id: newInstallationId })),
					updatedAt: new Date(),
				})
				.where(eq(integrations.id, sibling.id))

			await db.insert(events).values({
				workspaceId: sibling.workspaceId,
				actorId,
				action: 'updated',
				entityType: 'integration',
				entityId: sibling.id,
				data: {
					reason: 'installation_id_recovered',
					old_installation_id: expectedOldInstallationId,
					new_installation_id: newInstallationId,
					repo,
					propagated_from: sourceIntegrationId,
				},
			})
			updatedIntegrationIds.push(sibling.id)
		} catch (err) {
			logger.warn('Failed to propagate recovered installation id to sibling workspace', {
				integrationId: sibling.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	return { updatedIntegrationIds }
}
