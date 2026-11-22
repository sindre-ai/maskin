import type { KmsProvider } from '@maskin/auth/kms'
import type { Database, Transaction } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { decryptEnvelope, encryptEnvelope } from '../crypto'
import { recordEvent } from '../events/record-event'
import { insertCredentialAccessLog } from './credential-audit'
import { assertValidCredentialValue } from './credential-value'

/** Provider id of a row that holds a workspace's own sign-in app. The tool it is for is the externalId. */
export const OAUTH_APP_PROVIDER = 'oauth-app'
/** Mode of those rows. Lists skip them and resolveAgentAccess answers 'none' for them, so no grant can open the secret. */
export const OAUTH_APP_MODE = 'oauth_app'
/** Source on the audit row an app write leaves. */
export const OAUTH_APP_SOURCE = 'oauth_app_form'

export interface OAuthApp {
	clientId: string
	/** Empty for a public client, which has no secret. */
	clientSecret: string
	/** The customer's own address or tenant (OAuth2Config.customerValue). Not secret. */
	value?: string
}

export interface OAuthAppStatus {
	configured: boolean
	/** Not secret: it is on the sign-in URL the browser follows. */
	clientId?: string
	/** The customer's own address or tenant, for a tool that has one. Not secret. */
	value?: string
	updatedAt?: string
}

interface AppConfig {
	client_id?: string
	for_provider?: string
	/** Set when the app is a public client: no secret was saved. */
	public?: boolean
	/** The customer's own address or tenant. */
	value?: string
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
	const appConfig = row.config as AppConfig | null
	const clientId = appConfig?.client_id
	return {
		configured: true,
		...(clientId && { clientId }),
		...(appConfig?.value && { value: appConfig.value }),
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
	const appConfig = row?.config as AppConfig | null
	const clientId = appConfig?.client_id
	if (!row || !clientId) return null
	const value = appConfig?.value
	if (appConfig?.public) return { clientId, clientSecret: '', ...(value && { value }) }
	if (!row.credentials || !row.dekCiphertext) return null
	const clientSecret = await decryptEnvelope(kms, workspaceId, row.credentials, row.dekCiphertext)
	return { clientId, clientSecret, ...(value && { value }) }
}

/** A different app id was pasted while the tool is connected: its token belongs to the old app. */
export class OAuthAppInUseError extends Error {
	constructor() {
		super('The tool is connected with the saved app')
		this.name = 'OAuthAppInUseError'
	}
}

/** Whether the tool itself is connected in this workspace (not the app row). */
async function isConnected(
	db: Database | Transaction,
	workspaceId: string,
	provider: string,
): Promise<boolean> {
	const [row] = await db
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
	return !!row
}

export interface SaveOAuthAppInput {
	workspaceId: string
	/** The person pasting the app. */
	actorId: string
	provider: string
	displayName: string
	clientId: string
	/** Consumed here and never stored in the clear, logged or put on an event. Null for a public client. */
	clientSecret: string | null
	/** The customer's own address or tenant, already checked by the caller. Saved in the row's config. */
	value?: string
}

/**
 * Saves the app a customer's admin pasted, or replaces it. The secret goes through the
 * same envelope as a pasted API key (its own data key, wrapped by the master key) and every
 * write leaves a row in the credential audit chain. The app id sits in the row's config.
 * Saving again keeps the row, so the next sign-in and refresh read the new values. A new app id
 * is refused (OAuthAppInUseError) while the tool is connected, because its token was issued to the
 * old app; the same id with a new secret is fine.
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
	const config: AppConfig = {
		client_id: input.clientId,
		for_provider: provider,
		...(input.clientSecret === null && { public: true }),
		...(input.value && { value: input.value }),
	}
	let sealed: { credentials: string; dekCiphertext: string } | null = null
	if (input.clientSecret !== null) {
		assertValidCredentialValue(input.clientSecret)
		sealed = await encryptEnvelope(kms, workspaceId, input.clientSecret)
	}

	return db.transaction(async (tx) => {
		// One app per tool per workspace. The unique index does not cover a NULL actor, so serialise here.
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth-app:${workspaceId}:${provider}`}::text, 0))`,
		)
		const [existing] = await tx
			.select({ id: integrations.id, config: integrations.config })
			.from(integrations)
			.where(appWhere(workspaceId, provider))
			.for('update')
			.limit(1)

		let integrationId: string
		if (existing) {
			// A token was issued to the saved app at the saved address: a different id or address
			// would strand it.
			const saved = existing.config as AppConfig | null
			const changed =
				(!!saved?.client_id && saved.client_id !== input.clientId) ||
				(!!saved?.value && saved.value !== input.value)
			if (changed && (await isConnected(tx, workspaceId, provider))) {
				throw new OAuthAppInUseError()
			}
			integrationId = existing.id
			await tx
				.update(integrations)
				.set({
					status: 'active',
					config,
					credentials: sealed?.credentials ?? null,
					dekCiphertext: sealed?.dekCiphertext ?? null,
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
				credentials: sealed?.credentials ?? null,
				dekCiphertext: sealed?.dekCiphertext ?? null,
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
		const connected = await isConnected(tx, workspaceId, provider)
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
