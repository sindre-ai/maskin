import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { encryptEnvelope } from '../crypto'

/**
 * Writes a credential value as an envelope: credentials and dek_ciphertext are
 * set in one UPDATE, so a row never holds one without the other. A legacy row
 * (NULL dek_ciphertext) upgrades to envelope the first time it goes through here.
 *
 * The existing write paths (token refresh, reconnect) still write the legacy
 * form. They are not moved onto this in the same PR as the accessor: their
 * readers decrypt integrations.credentials directly and cannot read an envelope.
 */
export async function writeEnvelopeCredential(
	db: Database,
	kms: KmsProvider,
	params: { workspaceId: string; integrationId: string; plaintext: string },
): Promise<void> {
	const { credentials, dekCiphertext } = await encryptEnvelope(
		kms,
		params.workspaceId,
		params.plaintext,
	)
	const updated = await db
		.update(integrations)
		.set({ credentials, dekCiphertext, updatedAt: new Date() })
		.where(
			and(
				eq(integrations.id, params.integrationId),
				eq(integrations.workspaceId, params.workspaceId),
			),
		)
		.returning({ id: integrations.id })
	if (updated.length === 0) throw new Error(`Integration ${params.integrationId} not found`)
}
