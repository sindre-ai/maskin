import { randomUUID } from 'node:crypto'
import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { encryptEnvelope } from '../crypto'
import { recordEvent } from '../events/record-event'
import { insertKeychainGrants } from './agent-grants'
import { insertCredentialAccessLog } from './credential-audit'
import { assertSlugFree, assertValidCredentialName, lockCredentialSlug } from './credential-name'
import { assertValidLoginFields } from './login-value'

/** Provider id stored on a login: a username and password for a site or app. */
export const BYO_LOGIN_PROVIDER = 'login'

export interface LoginFields {
	username: string
	password: string
	/** For a site that has both a username and an email. Absent on a login saved without one. */
	email?: string
}

/**
 * What is encrypted for a login: one JSON document, so a login is one credential row,
 * one envelope and one audit trail like any other key.
 */
export function encodeLogin(login: LoginFields): string {
	return JSON.stringify({
		username: login.username,
		password: login.password,
		...(login.email !== undefined ? { email: login.email } : {}),
	})
}

/** The inverse of encodeLogin. Null for anything that is not a well-formed login. */
export function decodeLogin(value: string): LoginFields | null {
	try {
		const parsed: unknown = JSON.parse(value)
		if (typeof parsed !== 'object' || parsed === null) return null
		const { username, password, email } = parsed as Record<string, unknown>
		if (typeof username !== 'string' || typeof password !== 'string') return null
		if (email !== undefined && typeof email !== 'string') return null
		return email === undefined ? { username, password } : { username, password, email }
	} catch {
		return null
	}
}

export interface ByoLoginInput extends LoginFields {
	workspaceId: string
	/** The member adding the login. */
	actorId: string
	displayName: string
	/** Agents that may use the login. Omitted: nobody until a person grants one. */
	agentIds?: string[]
}

export interface ByoLoginResult {
	integrationId: string
	agentIds: string[]
}

/**
 * Vaults a login added in the Keychain form. The twin of createByoApiKey: same
 * envelope, name rule, uniqueness and audit chain; the row is active straight away
 * and no agent can use it until a person grants one.
 */
export async function createByoLogin(
	db: Database,
	kms: KmsProvider,
	input: ByoLoginInput,
): Promise<ByoLoginResult> {
	const { workspaceId, actorId } = input
	assertValidCredentialName(input.displayName)
	assertValidLoginFields(input.username, input.password, input.email)
	await assertSlugFree(db, workspaceId, input.displayName)
	const agentIds = input.agentIds ?? []
	const { credentials, dekCiphertext } = await encryptEnvelope(kms, workspaceId, encodeLogin(input))
	const integrationId = randomUUID()

	await db.transaction(async (tx) => {
		await lockCredentialSlug(tx, workspaceId, input.displayName)
		await assertSlugFree(tx, workspaceId, input.displayName)
		await tx.insert(integrations).values({
			id: integrationId,
			workspaceId,
			provider: BYO_LOGIN_PROVIDER,
			status: 'active',
			credentials,
			dekCiphertext,
			providerMode: 'byo_login',
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
			requestId: `byo-login:${integrationId}`,
		})
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'integration',
			entityId: integrationId,
			// Never the username, the password, the ciphertext or the wrapped key.
			data: { provider: BYO_LOGIN_PROVIDER, provider_mode: 'byo_login', source: 'admin_ui' },
		})
	})

	return { integrationId, agentIds }
}
