import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { rotateEnvelopeDek } from '../crypto'
import { insertCredentialAccessLog } from './credential-audit'

export type RotateDekOutcome = 'rotated' | 'not_found' | 'not_envelope' | 'changed'

/**
 * Re-wraps one credential under a fresh DEK and the current master key. The
 * decrypted value does not change. This is how a master key rotation reaches
 * existing credentials lazily: nothing is re-encrypted when the key changes, and a
 * credential picks up the new key the next time it goes through here.
 *
 * Legacy rows (no dek_ciphertext) are never touched: this is not the upgrade path,
 * and an envelope written here would break the readers that still decrypt
 * row.credentials under the old key.
 *
 * The UPDATE only matches while credentials and dek_ciphertext still hold what was
 * read, so a concurrent writer is never overwritten ('changed': safe to retry). The
 * 'rotated' audit row is written in the same transaction as the UPDATE.
 */
export async function rotateIntegrationDek(
	db: Database,
	kms: KmsProvider,
	params: {
		integrationId: string
		workspaceId: string
		/** Who is recorded in the audit log. Defaults to the row's creator (nightly job). */
		actorId?: string
		origin: 'manual' | 'nightly'
	},
): Promise<RotateDekOutcome> {
	const [row] = await db
		.select({
			credentials: integrations.credentials,
			dekCiphertext: integrations.dekCiphertext,
			createdBy: integrations.createdBy,
			source: integrations.source,
		})
		.from(integrations)
		.where(
			and(
				eq(integrations.id, params.integrationId),
				eq(integrations.workspaceId, params.workspaceId),
			),
		)
		.limit(1)
	if (!row) return 'not_found'
	if (row.credentials === null || row.dekCiphertext === null) return 'not_envelope'

	const next = await rotateEnvelopeDek(kms, params.workspaceId, row.credentials, row.dekCiphertext)

	return db.transaction(async (tx) => {
		const updated = await tx
			.update(integrations)
			.set({
				credentials: next.credentials,
				dekCiphertext: next.dekCiphertext,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(integrations.id, params.integrationId),
					eq(integrations.credentials, row.credentials as string),
					eq(integrations.dekCiphertext, row.dekCiphertext as string),
				),
			)
			.returning({ id: integrations.id })
		if (updated.length === 0) return 'changed' as const

		await insertCredentialAccessLog(tx, {
			workspaceId: params.workspaceId,
			integrationId: params.integrationId,
			actorId: params.actorId ?? row.createdBy,
			action: 'rotated',
			source: row.source,
			requestId: `rotate-dek:${params.origin}:${params.integrationId}`,
		})
		return 'rotated' as const
	})
}
