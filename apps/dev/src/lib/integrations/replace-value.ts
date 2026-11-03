import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { recordEvent } from '../events/record-event'
import { insertCredentialAccessLog } from './credential-audit'
import { assertValidCredentialValue } from './credential-value'
import { writeEnvelopeCredential } from './credential-write'

/** Source on the audit row a replaced value writes. */
export const REPLACE_VALUE_SOURCE = 'replace_value'

export type ReplaceValueOutcome = 'replaced' | 'not_found' | 'not_api_key' | 'not_active'

/**
 * Replaces the value of a saved API key in place: the row keeps its id, name and
 * grants, so every reference to it keeps working and only the next launch reads the new
 * value. A session that is already running was handed the old value in its env at
 * launch and keeps it.
 *
 * Runs the same value rule as the paste form before anything is encrypted; the error
 * names the rule and never repeats the value. The write and its 'rotated' audit row
 * share one transaction, so a replaced value without a log row cannot commit. The event
 * carries names only.
 */
export async function replaceCredentialValue(
	db: Database,
	kms: KmsProvider,
	params: { workspaceId: string; integrationId: string; actorId: string; rawSecret: string },
): Promise<ReplaceValueOutcome> {
	assertValidCredentialValue(params.rawSecret)

	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({
				providerMode: integrations.providerMode,
				status: integrations.status,
				provider: integrations.provider,
			})
			.from(integrations)
			.where(
				and(
					eq(integrations.id, params.integrationId),
					eq(integrations.workspaceId, params.workspaceId),
				),
			)
			.for('update')
			.limit(1)
		if (!row) return 'not_found' as const
		if (row.providerMode !== 'byo_apikey') return 'not_api_key' as const
		if (row.status !== 'active') return 'not_active' as const

		// Encrypts before the audit insert takes the chain lock, so no KMS call runs under it.
		await writeEnvelopeCredential(tx, kms, {
			workspaceId: params.workspaceId,
			integrationId: params.integrationId,
			plaintext: params.rawSecret,
		})
		await insertCredentialAccessLog(tx, {
			workspaceId: params.workspaceId,
			integrationId: params.integrationId,
			actorId: params.actorId,
			action: 'rotated',
			source: REPLACE_VALUE_SOURCE,
			requestId: `replace-value:${params.integrationId}:${crypto.randomUUID()}`,
		})
		await recordEvent(tx, {
			workspaceId: params.workspaceId,
			actorId: params.actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: params.integrationId,
			// Never the value, the ciphertext or the wrapped key.
			data: { change: 'value_replaced', provider: row.provider, provider_mode: row.providerMode },
		})
		return 'replaced' as const
	})
}
