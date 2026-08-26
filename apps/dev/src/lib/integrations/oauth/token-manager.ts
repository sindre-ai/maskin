import type { Database } from '@maskin/db'
import { events, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { decrypt, encrypt } from '../../crypto'
import { logger } from '../../logger'
import { IntegrationAuthRevokedError } from '../errors'
import type { ResolvedProvider, StoredCredentials } from '../types'
import { OAuth2Handler, TokenRequestError } from './handler'

/** Buffer time before expiry to trigger a refresh (5 minutes) */
const REFRESH_BUFFER_MS = 5 * 60 * 1000

/**
 * Process-local map of in-flight refreshes keyed by integration ID.
 *
 * AC-T5: when N parallel tool calls hit an expired token, only the first one
 * actually exchanges with the provider's token endpoint. Subsequent callers
 * await the same Promise and reuse its resolved access token.
 *
 * Scope is intentionally per-Node-process — multi-process deployments would
 * need a Postgres advisory lock, which is overkill for a 5-min refresh window
 * and the existing single-process API server.
 */
const inflightRefreshes = new Map<string, Promise<string>>()

export class TokenManager {
	/**
	 * Get a valid access token for an integration.
	 * Handles lazy refresh: if the token is about to expire and a refresh token
	 * is available, it will refresh and store the updated credentials.
	 *
	 * Concurrent calls for the same integration ID share a single outbound
	 * refresh request, on both the standard OAuth2 and custom-auth paths (see
	 * {@link inflightRefreshes}).
	 *
	 * Throws {@link IntegrationAuthRevokedError} when `integration.status` is
	 * `'revoked'` (short-circuit) or when the provider returns `invalid_grant`
	 * on refresh (status flipped to `'revoked'` in the same transaction).
	 */
	async getValidToken(
		db: Database,
		integrationId: string,
		provider: ResolvedProvider,
	): Promise<string> {
		// Read integration row
		const [integration] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, integrationId))
			.limit(1)

		if (!integration) {
			throw new Error(`Integration ${integrationId} not found`)
		}

		// Short-circuit: integration was already marked revoked. Don't re-hit
		// the provider — the user must reconnect.
		if (integration.status === 'revoked') {
			throw new IntegrationAuthRevokedError(integrationId)
		}

		const credentials: StoredCredentials = JSON.parse(decrypt(integration.credentials))

		// Custom auth providers handle their own token generation. Shares the same
		// in-flight dedup as the standard path: a handler may perform a *stateful*
		// refresh (rotating refresh_token, moving expires_at) rather than minting a
		// stateless token per call like GitHub App installation tokens, and two
		// concurrent callers would then race to spend the same one-use refresh
		// token — the loser gets invalid_grant, which this layer reads as a revoked
		// grant and flips a perfectly healthy integration to `revoked`.
		if (provider.customAuth) {
			return this.dedupe(integrationId, () =>
				this.runCustomAuth(db, integrationId, provider, credentials, {
					workspaceId: integration.workspaceId,
					createdBy: integration.createdBy,
				}),
			)
		}

		// API key providers return the stored key directly
		if (provider.config.auth.type === 'api_key') {
			if (!credentials.accessToken) {
				throw new Error(`Integration ${integrationId} has no stored API key`)
			}
			return credentials.accessToken
		}

		// Standard OAuth2 flow
		if (!credentials.accessToken) {
			throw new Error(`Integration ${integrationId} has no access token`)
		}

		// No expiry set — token doesn't expire, return as-is
		if (!credentials.expiresAt) {
			return credentials.accessToken
		}

		// Token still valid — return as-is
		if (credentials.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
			return credentials.accessToken
		}

		// Token expired or about to expire — try to refresh
		if (!credentials.refreshToken) {
			throw new Error(
				`Integration ${integrationId} access token expired and no refresh token available. User must reconnect.`,
			)
		}

		if (provider.config.auth.type !== 'oauth2') {
			throw new Error(`Cannot refresh token for auth type: ${provider.config.auth.type}`)
		}

		return this.refreshWithDedup(
			db,
			integrationId,
			provider,
			credentials,
			integration.workspaceId,
			integration.createdBy,
		)
	}

	/**
	 * Mark an integration as revoked. Called from data-call paths (e.g. T3 read
	 * tools) when a Google API returns 401 against a token that was valid when
	 * we last refreshed — meaning the grant was revoked between then and now.
	 *
	 * Idempotent: re-marking a row already `revoked` is a no-op WHERE-clause
	 * UPDATE, not an error.
	 */
	async markRevoked(db: Database, integrationId: string): Promise<void> {
		await db.transaction(async (tx) => {
			const [row] = await tx
				.select({ workspaceId: integrations.workspaceId, createdBy: integrations.createdBy })
				.from(integrations)
				.where(eq(integrations.id, integrationId))
				.limit(1)

			// Only update (and audit-log) when the row is not already revoked.
			// Without this guard, two concurrent invalid_grant errors both pass the
			// SELECT under READ COMMITTED and produce duplicate audit event rows.
			const updated = await tx
				.update(integrations)
				.set({ status: 'revoked', updatedAt: new Date() })
				.where(and(eq(integrations.id, integrationId), eq(integrations.status, 'active')))
				.returning({ id: integrations.id })

			if (updated.length > 0 && row) {
				await tx.insert(events).values({
					workspaceId: row.workspaceId,
					actorId: row.createdBy,
					action: 'updated',
					entityType: 'integration',
					entityId: integrationId,
					data: { status: 'revoked', reason: 'token_revoked' },
				})
			}
		})

		logger.info('Integration marked as revoked', { integrationId })
	}

	private refreshWithDedup(
		db: Database,
		integrationId: string,
		provider: ResolvedProvider,
		credentials: StoredCredentials,
		workspaceId: string,
		actorId: string,
	): Promise<string> {
		return this.dedupe(integrationId, () =>
			this.doRefresh(db, integrationId, provider, credentials, workspaceId, actorId),
		)
	}

	/**
	 * Run `task` under the process-local in-flight lock for `integrationId`, so
	 * concurrent callers share one outbound token exchange instead of racing to
	 * spend the same one-use refresh token.
	 */
	private dedupe(integrationId: string, task: () => Promise<string>): Promise<string> {
		const existing = inflightRefreshes.get(integrationId)
		if (existing) {
			return existing
		}

		const promise = task().finally(() => {
			inflightRefreshes.delete(integrationId)
		})
		inflightRefreshes.set(integrationId, promise)
		return promise
	}

	/**
	 * Invoke a provider's custom auth handler, handing it a write-back channel so
	 * a rotated refresh token and the new expiry are persisted — without it the
	 * next refresh replays a consumed token and strands the integration.
	 */
	private async runCustomAuth(
		db: Database,
		integrationId: string,
		provider: ResolvedProvider,
		credentials: StoredCredentials,
		owner: { workspaceId: string; createdBy: string },
	): Promise<string> {
		if (!provider.customAuth) {
			throw new Error(`Provider ${provider.config.name} has no custom auth handler`)
		}

		try {
			return await provider.customAuth.getAccessToken(credentials, {
				integrationId,
				persistCredentials: (updated) =>
					this.persistCredentials(
						db,
						integrationId,
						updated,
						owner.workspaceId,
						owner.createdBy,
						provider.config.name,
					),
			})
		} catch (err) {
			// Mirror doRefresh: a handler that reports the grant as gone flips the
			// row to `revoked` so subsequent calls short-circuit without re-hitting
			// the provider. markRevoked failure must not suppress the original error.
			if (err instanceof IntegrationAuthRevokedError) {
				try {
					await this.markRevoked(db, integrationId)
				} catch (markErr) {
					logger.warn('Failed to persist revoked status for integration', {
						integrationId,
						error: String(markErr),
					})
				}
			}
			throw err
		}
	}

	private async doRefresh(
		db: Database,
		integrationId: string,
		provider: ResolvedProvider,
		credentials: StoredCredentials,
		workspaceId: string,
		actorId: string,
	): Promise<string> {
		// Type guards: getValidToken already enforces both before reaching doRefresh,
		// but TypeScript requires them here to narrow the union types so the compiler
		// allows access to provider.config.auth.config and credentials.refreshToken.
		if (provider.config.auth.type !== 'oauth2') {
			throw new Error(`Cannot refresh token for auth type: ${provider.config.auth.type}`)
		}
		if (!credentials.refreshToken) {
			throw new Error(`Integration ${integrationId} has no refresh token`)
		}

		const oauth2Config = provider.config.auth.config
		const handler = new OAuth2Handler(oauth2Config, provider.parseTokenResponse)

		let refreshed: StoredCredentials
		try {
			refreshed = await handler.refreshToken(credentials.refreshToken)
		} catch (err) {
			if (err instanceof TokenRequestError && err.oauthError === 'invalid_grant') {
				// User revoked the grant externally (Google Account → Security → Third-party
				// access). Flip status so subsequent calls short-circuit without hitting
				// the provider — see the `status === 'revoked'` branch in getValidToken.
				// markRevoked failure (transient DB error) must not suppress the revocation
				// error — log and continue so the caller always gets IntegrationAuthRevokedError.
				try {
					await this.markRevoked(db, integrationId)
				} catch (markErr) {
					// DB write failed — log and continue. The caller still gets
					// IntegrationAuthRevokedError; the next call will retry markRevoked.
					logger.warn('Failed to persist revoked status for integration', {
						integrationId,
						error: String(markErr),
					})
				}
				throw new IntegrationAuthRevokedError(
					integrationId,
					`Integration ${integrationId} refresh rejected with invalid_grant — user must reconnect`,
				)
			}
			throw err
		}

		// A refresh response that omits access_token is malformed. The fallback
		// `?? credentials.accessToken` would silently re-store the expired token
		// because credentials.accessToken is always non-empty at this point (enforced
		// at line 77), making the guard below dead. Throw explicitly instead.
		if (!refreshed.accessToken) {
			throw new Error(
				`Integration ${integrationId} token refresh did not return an access token. User must reconnect.`,
			)
		}

		// Merge: keep existing fields (like provider-specific data), override with refreshed tokens
		const updated: StoredCredentials = {
			...credentials,
			accessToken: refreshed.accessToken,
			// Do NOT fall back to credentials.expiresAt: that timestamp is already in the
			// past (it triggered this refresh), so inheriting it causes getValidToken to
			// immediately re-refresh on every subsequent call. If the provider omits
			// expires_in, the token is treated as non-expiring until proven otherwise.
			expiresAt: refreshed.expiresAt,
			scope: refreshed.scope ?? credentials.scope,
			tokenType: refreshed.tokenType ?? credentials.tokenType,
		}

		// Some providers return a new refresh token; update if present
		if (refreshed.refreshToken) {
			updated.refreshToken = refreshed.refreshToken
		}

		await this.persistCredentials(
			db,
			integrationId,
			updated,
			workspaceId,
			actorId,
			provider.config.name,
		)

		return refreshed.accessToken
	}

	/**
	 * Store refreshed credentials and record the audit event.
	 *
	 * The credentials UPDATE MUST NOT share a transaction with the events INSERT:
	 * the token exchange that produced these credentials is not idempotent — it
	 * already consumed the old refresh token and issued a new one. If the events
	 * INSERT later failed and rolled back the UPDATE, the DB would revert to the
	 * now-invalid refresh token, causing the next refresh to return invalid_grant
	 * and permanently stranding the integration. Credentials go first, audit log
	 * is best-effort.
	 */
	private async persistCredentials(
		db: Database,
		integrationId: string,
		credentials: StoredCredentials,
		workspaceId: string,
		actorId: string,
		providerName: string,
	): Promise<void> {
		const encryptedCredentials = encrypt(JSON.stringify(credentials))
		await db
			.update(integrations)
			.set({ credentials: encryptedCredentials, updatedAt: new Date() })
			.where(eq(integrations.id, integrationId))

		try {
			await db.insert(events).values({
				workspaceId,
				actorId,
				action: 'updated',
				entityType: 'integration',
				entityId: integrationId,
				data: { reason: 'token_refreshed', provider: providerName },
			})
		} catch (auditErr) {
			logger.warn('Failed to insert token_refreshed audit event', {
				integrationId,
				error: String(auditErr),
			})
		}

		logger.info('Refreshed OAuth2 access token', {
			integrationId,
			provider: providerName,
		})
	}
}
