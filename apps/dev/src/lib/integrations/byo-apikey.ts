import { randomUUID } from 'node:crypto'
import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { type ScopeGrant, integrations } from '@maskin/db/schema'
import { encryptEnvelope } from '../crypto'
import { recordEvent } from '../events/record-event'
import { insertCredentialAccessLog } from './credential-audit'

/** Provider id stored on a key pasted in the Keychain, where no service was detected. */
export const BYO_APIKEY_PROVIDER = 'custom'

export interface ByoApiKeyInput {
	workspaceId: string
	/** The member pasting the key. */
	actorId: string
	displayName: string
	/** Consumed here and never stored, logged or put on an event. */
	rawSecret: string
}

export interface ByoApiKeyResult {
	integrationId: string
	scopeGrants: ScopeGrant[]
}

/**
 * Vaults a key pasted in the Keychain paste form. Same envelope and audit chain
 * as a chat capture, minus the session and the undo window: the row is active
 * straight away. Scope defaults to one actor grant for the member who pasted it.
 *
 * The DEK is generated, used, wrapped and zeroised inside encryptEnvelope before
 * the transaction opens, so no KMS call happens while the audit chain lock is held.
 */
export async function createByoApiKey(
	db: Database,
	kms: KmsProvider,
	input: ByoApiKeyInput,
): Promise<ByoApiKeyResult> {
	const { workspaceId, actorId } = input
	const grants: ScopeGrant[] = [{ kind: 'actor', actorId }]
	const { credentials, dekCiphertext } = await encryptEnvelope(kms, workspaceId, input.rawSecret)
	const integrationId = randomUUID()

	await db.transaction(async (tx) => {
		await tx.insert(integrations).values({
			id: integrationId,
			workspaceId,
			provider: BYO_APIKEY_PROVIDER,
			status: 'active',
			credentials,
			dekCiphertext,
			providerMode: 'byo_apikey',
			displayName: input.displayName,
			scopeGrants: grants,
			source: 'admin_ui',
			createdBy: actorId,
		})
		await insertCredentialAccessLog(tx, {
			workspaceId,
			integrationId,
			actorId,
			action: 'create',
			source: 'admin_ui',
			requestId: `byo-apikey:${integrationId}`,
		})
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'integration',
			entityId: integrationId,
			// Never the value, the ciphertext or the wrapped key.
			data: { provider: BYO_APIKEY_PROVIDER, provider_mode: 'byo_apikey', source: 'admin_ui' },
		})
	})

	return { integrationId, scopeGrants: grants }
}
