import { randomUUID } from 'node:crypto'
import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { encryptEnvelope } from '../crypto'
import { recordEvent } from '../events/record-event'
import { insertKeychainGrants } from './agent-grants'
import { insertCredentialAccessLog } from './credential-audit'
import { assertSlugFree, assertValidCredentialName, lockCredentialSlug } from './credential-name'
import { assertValidCredentialValue } from './credential-value'

/** Provider id stored on a key pasted in the Keychain, where no service was detected. */
export const BYO_APIKEY_PROVIDER = 'custom'

export interface ByoApiKeyInput {
	workspaceId: string
	/** The member pasting the key. */
	actorId: string
	displayName: string
	/** Consumed here and never stored, logged or put on an event. */
	rawSecret: string
	/** Agents that may use the key. Omitted: nobody until a person grants it. */
	agentIds?: string[]
}

export interface ByoApiKeyResult {
	integrationId: string
	agentIds: string[]
}

/**
 * Vaults a key pasted in the Keychain paste form. Same envelope and audit chain
 * as a chat capture, minus the session and the undo window: the row is active
 * straight away. No agent can use it until a person grants one.
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
	// The same name rule and uniqueness as a chat capture, so one name means one env var.
	// A taken name is refused before the KMS call; the check repeats under the lock below.
	assertValidCredentialName(input.displayName)
	// Before anything is read or encrypted. The message never repeats the value.
	assertValidCredentialValue(input.rawSecret)
	await assertSlugFree(db, workspaceId, input.displayName)
	const agentIds = input.agentIds ?? []
	const { credentials, dekCiphertext } = await encryptEnvelope(kms, workspaceId, input.rawSecret)
	const integrationId = randomUUID()

	await db.transaction(async (tx) => {
		await lockCredentialSlug(tx, workspaceId, input.displayName)
		await assertSlugFree(tx, workspaceId, input.displayName)
		await tx.insert(integrations).values({
			id: integrationId,
			workspaceId,
			provider: BYO_APIKEY_PROVIDER,
			status: 'active',
			credentials,
			dekCiphertext,
			providerMode: 'byo_apikey',
			displayName: input.displayName,
			defaultAgentAccess: 'none',
			source: 'admin_ui',
			createdBy: actorId,
		})
		await insertKeychainGrants(tx, {
			workspaceId,
			integrationId,
			actorIds: agentIds,
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

	return { integrationId, agentIds }
}
