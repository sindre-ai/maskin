import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { decryptStoredCredential, encryptEnvelope } from '../crypto'
import { recordEvent } from '../events/record-event'
import { type LoginFields, decodeLogin, encodeLogin } from './byo-login'
import { insertCredentialAccessLog } from './credential-audit'
import { assertSlugFree, assertValidCredentialName, lockCredentialSlug } from './credential-name'
import { assertValidCredentialValue } from './credential-value'
import { assertValidLoginFields } from './login-value'

export interface CredentialUpdateInput {
	workspaceId: string
	integrationId: string
	/** The person making the change. */
	actorId: string
	/** A new name. Omitted: the name stays. */
	displayName?: string
	/** A new API key. Only for a key. Consumed here, never stored in the clear, logged or put on an event. */
	rawSecret?: string
	/**
	 * Any of a new username, password and email. Only for a login. What is left out stays as saved.
	 * An email is added or replaced here, not removed.
	 */
	login?: Partial<LoginFields>
}

export type CredentialUpdateOutcome =
	| { kind: 'updated'; renamed: boolean; secretReplaced: boolean }
	| { kind: 'not_found' }
	| { kind: 'forbidden' }
	| { kind: 'not_editable' }
	| { kind: 'wrong_shape' }
	| { kind: 'unreadable_login' }

/**
 * Renames a saved key or login, replaces its secret, or both. A login may change one part (just the
 * password, say): the rest is read from the saved login and written back with it. Only an active
 * key or login: an OAuth connection is reconnected on the Integrations page, and a removed one has
 * no secret left.
 *
 * The name is the env var an agent reads (KEYCHAIN_BYO_APIKEY_<NAME>), so a rename changes what
 * agents and tool servers must call it. The new name goes through the same rule and uniqueness as
 * a new credential. A new secret is encrypted before the transaction opens, so no KMS call happens
 * while the row lock or the audit chain lock is held, and is written with its wrapped key in one
 * UPDATE. A running session keeps what it was launched with until it ends; the next one gets the new value.
 */
export async function updateCredential(
	db: Database,
	kms: KmsProvider,
	input: CredentialUpdateInput,
	canEdit: (createdBy: string) => Promise<boolean>,
): Promise<CredentialUpdateOutcome> {
	const { workspaceId, integrationId, actorId } = input
	const wantsSecret = input.rawSecret !== undefined || input.login !== undefined

	// Validate before anything is read or encrypted. Messages never repeat a value.
	if (input.displayName !== undefined) assertValidCredentialName(input.displayName)
	if (input.rawSecret !== undefined) assertValidCredentialValue(input.rawSecret)

	const [row] = await db
		.select({
			createdBy: integrations.createdBy,
			providerMode: integrations.providerMode,
			status: integrations.status,
			displayName: integrations.displayName,
			source: integrations.source,
			credentials: integrations.credentials,
			dekCiphertext: integrations.dekCiphertext,
		})
		.from(integrations)
		.where(and(eq(integrations.id, integrationId), eq(integrations.workspaceId, workspaceId)))
		.limit(1)
	if (!row) return { kind: 'not_found' }
	if (!(await canEdit(row.createdBy))) return { kind: 'forbidden' }
	if (
		(row.providerMode !== 'byo_apikey' && row.providerMode !== 'byo_login') ||
		row.status !== 'active'
	) {
		return { kind: 'not_editable' }
	}
	// A key takes a key and a login takes a login; mixing them would store the wrong shape.
	if (
		(input.rawSecret !== undefined && row.providerMode !== 'byo_apikey') ||
		(input.login !== undefined && row.providerMode !== 'byo_login')
	) {
		return { kind: 'wrong_shape' }
	}

	// A login changes a part at a time, so start from what is saved. Validate the whole result: the
	// saved parts passed the rules when they were saved, the new ones are checked here.
	let login: LoginFields | undefined
	if (input.login) {
		const saved =
			row.credentials === null
				? undefined
				: decodeLogin(
						await decryptStoredCredential(kms, {
							workspaceId,
							credentials: row.credentials,
							dekCiphertext: row.dekCiphertext,
						}),
					)
		const username = input.login.username ?? saved?.username
		const password = input.login.password ?? saved?.password
		const email = input.login.email ?? saved?.email
		// A login that cannot be read can still be replaced whole, but not changed a part at a time.
		if (username === undefined || password === undefined) return { kind: 'unreadable_login' }
		login = { username, password, ...(email !== undefined ? { email } : {}) }
		assertValidLoginFields(login.username, login.password, login.email)
	}

	const renamed = input.displayName !== undefined && input.displayName !== row.displayName
	if (renamed && input.displayName !== undefined) {
		await assertSlugFree(db, workspaceId, input.displayName, integrationId)
	}

	const sealed = wantsSecret
		? await encryptEnvelope(
				kms,
				workspaceId,
				login ? encodeLogin(login) : (input.rawSecret as string),
			)
		: null

	return db.transaction(async (tx) => {
		if (renamed && input.displayName !== undefined) {
			await lockCredentialSlug(tx, workspaceId, input.displayName)
			await assertSlugFree(tx, workspaceId, input.displayName, integrationId)
		}
		// Locked, so two edits queue and the second sees the first, or a removal.
		const [current] = await tx
			.select({ status: integrations.status })
			.from(integrations)
			.where(eq(integrations.id, integrationId))
			.for('update')
			.limit(1)
		if (!current || current.status !== 'active') return { kind: 'not_editable' as const }

		await tx
			.update(integrations)
			.set({
				...(renamed ? { displayName: input.displayName } : {}),
				...(sealed ? { credentials: sealed.credentials, dekCiphertext: sealed.dekCiphertext } : {}),
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, integrationId))

		if (sealed) {
			await insertCredentialAccessLog(tx, {
				workspaceId,
				integrationId,
				actorId,
				action: 'rotated',
				source: row.source,
				requestId: `update:${integrationId}:${Date.now()}`,
			})
		}
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: integrationId,
			// Never the value, the ciphertext or the wrapped key. Names are not logged here either:
			// a name that looks like a secret is refused, but the event only needs to say what changed.
			data: {
				change: 'credential_updated',
				provider_mode: row.providerMode,
				renamed,
				secret_replaced: sealed !== null,
			},
		})
		return { kind: 'updated' as const, renamed, secretReplaced: sealed !== null }
	})
}
