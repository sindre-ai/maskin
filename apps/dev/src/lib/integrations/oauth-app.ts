import type { KmsProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { decryptEnvelope, encryptEnvelope } from '../crypto'
import { recordEvent } from '../events/record-event'
import { insertCredentialAccessLog } from './credential-audit'
import { assertValidCredentialValue } from './credential-value'

/** Provider id of a row that holds a workspace's own sign-in app. The tool it is for is the externalId. */
export const OAUTH_APP_PROVIDER = 'oauth-app'
/** Mode of those rows. Kept apart from the Keychain modes so no agent grant or Keychain list touches them. */
export const OAUTH_APP_MODE = 'oauth_app'
/** Source on the audit row an app write leaves. */
export const OAUTH_APP_SOURCE = 'oauth_app_form'

export interface OAuthApp {
	clientId: string
	clientSecret: string
}

export interface OAuthAppStatus {
	configured: boolean
	/** Not secret: it is on the sign-in URL the browser follows. */
	clientId?: string
	updatedAt?: string
}

interface AppConfig {
	client_id?: string
	for_provider?: string
}

function appWhere(workspaceId: string, provider: string) {
	return and(
		eq(integrations.workspaceId, workspaceId),
		eq(integrations.provider, OAUTH_APP_PROVIDER),
		eq(integrations.providerMode, OAUTH_APP_MODE),
		eq(integrations.externalId, provider),
	)
}

/** Whether a workspace has saved its own app for a tool, and its app id. Never the secret. */
export async function getOAuthAppStatus(
	db: Database,
	workspaceId: string,
	provider: string,
): Promise<OAuthAppStatus> {
	const [row] = await db
		.select({ config: integrations.config, updatedAt: integrations.updatedAt })
		.from(integrations)
		.where(and(appWhere(workspaceId, provider), eq(integrations.status, 'active')))
		.limit(1)
	if (!row) return { configured: false }
	const clientId = (row.config as AppConfig | null)?.client_id
	return {
		configured: true,
		...(clientId && { clientId }),
		...(row.updatedAt && { updatedAt: row.updatedAt.toISOString() }),
	}
}

/**
 * The workspace's own app for a tool, decrypted, or null when it has none. Scoped by
 * workspace id in the query: another workspace's app can never come back from here.
 */
export async function loadOAuthApp(
	db: Database,
	kms: KmsProvider,
	workspaceId: string,
	provider: string,
): Promise<OAuthApp | null> {
	const [row] = await db
		.select({
			config: integrations.config,
			credentials: integrations.credentials,
			dekCiphertext: integrations.dekCiphertext,
		})
		.from(integrations)
		.where(and(appWhere(workspaceId, provider), eq(integrations.status, 'active')))
		.limit(1)
	const clientId = (row?.config as AppConfig | null)?.client_id
	if (!row?.credentials || !row.dekCiphertext || !clientId) return null
	const clientSecret = await decryptEnvelope(kms, workspaceId, row.credentials, row.dekCiphertext)
	return { clientId, clientSecret }
}

export interface SaveOAuthAppInput {
	workspaceId: string
	/** The person pasting the app. */
	actorId: string
	provider: string
	displayName: string
	clientId: string
	/** Consumed here and never stored in the clear, logged or put on an event. */
	clientSecret: string
}

/**
 * Saves the app a customer's admin pasted, or replaces it. The secret goes through the
 * same envelope as a pasted API key (its own data key, wrapped by the master key) and every
 * write leaves a row in the credential audit chain. The app id sits in the row's config.
 * Saving again keeps the row, so the next sign-in and refresh read the new values.
 *
 * Encrypts before the transaction opens, so no key call happens while the audit chain lock is held.
 */
export async function saveOAuthApp(
	db: Database,
	kms: KmsProvider,
	input: SaveOAuthAppInput,
): Promise<{ integrationId: string; created: boolean }> {
	const { workspaceId, actorId, provider } = input
	// The app id is not secret, but it rides the same value rule: it ends up in a URL and a form body.
	assertValidCredentialValue(input.clientId)
	assertValidCredentialValue(input.clientSecret)
	const config: AppConfig = { client_id: input.clientId, for_provider: provider }
	const sealed = await encryptEnvelope(kms, workspaceId, input.clientSecret)

	return db.transaction(async (tx) => {
		// One app per tool per workspace. The unique index does not cover a NULL actor, so serialise here.
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth-app:${workspaceId}:${provider}`}::text, 0))`,
		)
		const [existing] = await tx
			.select({ id: integrations.id })
			.from(integrations)
			.where(appWhere(workspaceId, provider))
			.for('update')
			.limit(1)

		let integrationId: string
		if (existing) {
			integrationId = existing.id
			await tx
				.update(integrations)
				.set({
					status: 'active',
					config,
					credentials: sealed.credentials,
					dekCiphertext: sealed.dekCiphertext,
					updatedAt: new Date(),
				})
				.where(eq(integrations.id, integrationId))
		} else {
			integrationId = crypto.randomUUID()
			await tx.insert(integrations).values({
				id: integrationId,
				workspaceId,
				provider: OAUTH_APP_PROVIDER,
				externalId: provider,
				status: 'active',
				credentials: sealed.credentials,
				dekCiphertext: sealed.dekCiphertext,
				config,
				providerMode: OAUTH_APP_MODE,
				displayName: input.displayName,
				defaultAgentAccess: 'none',
				source: 'admin_ui',
				createdBy: actorId,
			})
		}
		await insertCredentialAccessLog(tx, {
			workspaceId,
			integrationId,
			actorId,
			action: existing ? 'rotated' : 'create',
			source: OAUTH_APP_SOURCE,
			requestId: `oauth-app:${integrationId}:${crypto.randomUUID()}`,
		})
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: existing ? 'updated' : 'created',
			entityType: 'integration',
			entityId: integrationId,
			// Names only: never the secret, the ciphertext or the wrapped key.
			data: { provider: OAUTH_APP_PROVIDER, for_provider: provider, provider_mode: OAUTH_APP_MODE },
		})
		return { integrationId, created: !existing }
	})
}

export type DeleteOAuthAppOutcome = 'deleted' | 'not_found' | 'in_use'

/**
 * Removes the saved app. Refused while the tool is connected: its token refreshes with this
 * app, so removing it would leave a connection that can no longer renew.
 */
export async function deleteOAuthApp(
	db: Database,
	params: { workspaceId: string; actorId: string; provider: string },
): Promise<DeleteOAuthAppOutcome> {
	const { workspaceId, actorId, provider } = params
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth-app:${workspaceId}:${provider}`}::text, 0))`,
		)
		const [row] = await tx
			.select({ id: integrations.id })
			.from(integrations)
			.where(and(appWhere(workspaceId, provider), eq(integrations.status, 'active')))
			.for('update')
			.limit(1)
		if (!row) return 'not_found' as const
		const [connected] = await tx
			.select({ id: integrations.id })
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, provider),
					eq(integrations.providerMode, 'registered'),
					eq(integrations.status, 'active'),
				),
			)
			.limit(1)
		if (connected) return 'in_use' as const
		// Wipe the secret in place and keep the row: the audit chain points at it.
		await tx
			.update(integrations)
			.set({ status: 'undone', credentials: null, dekCiphertext: null, updatedAt: new Date() })
			.where(eq(integrations.id, row.id))
		await insertCredentialAccessLog(tx, {
			workspaceId,
			integrationId: row.id,
			actorId,
			action: 'undone',
			source: OAUTH_APP_SOURCE,
			requestId: `oauth-app:${row.id}:${crypto.randomUUID()}`,
		})
		await recordEvent(tx, {
			workspaceId,
			actorId,
			action: 'deleted',
			entityType: 'integration',
			entityId: row.id,
			data: { provider: OAUTH_APP_PROVIDER, for_provider: provider, provider_mode: OAUTH_APP_MODE },
		})
		return 'deleted' as const
	})
}
