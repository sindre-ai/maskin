import { randomBytes } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	integrations,
	webhookDeliveries,
	workspaceMembers,
} from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { skjaldTranscriptionCompletedPayloadSchema } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { trackSlackMentionReceived } from '../lib/analytics/loop-events'
import { markSlackMention } from '../lib/analytics/slack-attribution'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError } from '../lib/errors'
import { isAuthRevokedError } from '../lib/integrations/errors'
import { normalizeEvent } from '../lib/integrations/events/normalizer'
import { OAuth2Handler } from '../lib/integrations/oauth/handler'
import { generateCodeVerifier } from '../lib/integrations/oauth/pkce'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import {
	DiscoveryError,
	fetchInstallationOwnerLogin,
	mintInstallationTokenWithRecovery,
} from '../lib/integrations/providers/github/auth'
import { persistRecoveredInstallationId } from '../lib/integrations/providers/github/installation-recovery'
import { upsertSkjaldMeeting } from '../lib/integrations/providers/skjald/meeting-sync'
import {
	dispatchAccountLinkAction,
	dispatchMaskinWorkspaceCommand,
	maybePromptAccountLink,
	ownsAccountLinkInteraction,
} from '../lib/integrations/providers/slack/account-link'
import {
	type SlackConversationType,
	listSlackConversations,
	listSlackUsers,
} from '../lib/integrations/providers/slack/client'
import { config as slackProviderConfig } from '../lib/integrations/providers/slack/config'
import {
	extractChannelId,
	extractMentioningSlackUserId,
	getMentionSurface,
	resolveMentionDispatch,
} from '../lib/integrations/providers/slack/identity'
import {
	handleSlackInteractivePayload,
	parseSlackInteractivePayload,
	sendEphemeralResponse,
	slackInteractiveDeliveryId,
} from '../lib/integrations/providers/slack/interactive'
import { getProvider, listProviders } from '../lib/integrations/registry'
import type {
	NormalizedEvent,
	ResolvedProvider,
	StoredCredentials,
} from '../lib/integrations/types'
import { ClaimReleasedError, commitWebhookDelivery } from '../lib/integrations/webhooks/commit'
import { WebhookHandler } from '../lib/integrations/webhooks/handler'
import { verifyTimestampSignature } from '../lib/integrations/webhooks/signatures'
import { logger } from '../lib/logger'
import {
	errorSchema,
	idParamSchema,
	integrationResponseSchema,
	providerInfoSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serializeArray } from '../lib/serialize'
import type { IntegrationConfig } from '../lib/types'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		storageProvider: StorageProvider
	}
}

const app = new OpenAPIHono<Env>()

// ── GET /api/integrations ──────────────────────────────────────────────────

const listIntegrationsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['integrations'],
	summary: 'List integrations for workspace',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'List of integrations',
			content: { 'application/json': { schema: z.array(integrationResponseSchema) } },
		},
	},
})

app.openapi(listIntegrationsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const results = await db
		.select()
		.from(integrations)
		.where(eq(integrations.workspaceId, workspaceId))

	// Never expose credentials
	const safe = results.map((r) => {
		const { credentials, ...rest } = r
		return rest
	})

	return c.json(serializeArray(safe) as z.infer<typeof integrationResponseSchema>[])
}) as RouteHandler<typeof listIntegrationsRoute, Env>)

// ── GET /api/integrations/providers ────────────────────────────────────────

const listProvidersRoute = createRoute({
	method: 'get',
	path: '/providers',
	tags: ['integrations'],
	summary: 'List available integration providers',
	responses: {
		200: {
			description: 'List of providers',
			content: { 'application/json': { schema: z.array(providerInfoSchema) } },
		},
	},
})

app.openapi(listProvidersRoute, (async (c) => {
	const providers = listProviders().map((p) => ({
		name: p.config.name,
		displayName: p.config.displayName,
		authType: p.config.auth.type,
		events: p.config.events?.definitions ?? [],
		externalIdDisplay: p.config.externalIdDisplay,
	}))

	return c.json(providers as z.infer<typeof providerInfoSchema>[])
}) as RouteHandler<typeof listProvidersRoute, Env>)

// ── POST /api/integrations/:provider/connect ───────────────────────────────

const providerParamSchema = z.object({ provider: z.string() })

const connectRoute = createRoute({
	method: 'post',
	path: '/{provider}/connect',
	tags: ['integrations'],
	summary: 'Start integration connection flow',
	request: {
		params: providerParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description:
				'Install URL for OAuth/GitHub App, or a webhook URL + integration id for manual-auth providers',
			content: {
				'application/json': {
					schema: z.object({
						install_url: z.string().optional(),
						webhook_url: z.string().optional(),
						integration_id: z.string().optional(),
					}),
				},
			},
		},
		400: {
			description: 'Error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(connectRoute, (async (c) => {
	const db = c.get('db')
	const { provider: providerName } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const actorId = c.get('actorId')

	let resolved: ResolvedProvider
	try {
		resolved = getProvider(providerName)
	} catch {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				`Unknown provider: ${providerName}`,
				undefined,
				`Available providers: ${listProviders()
					.map((p) => p.config.name)
					.join(', ')}`,
			),
			400,
		)
	}

	// api_key providers skip the OAuth round-trip — the platform owns the key,
	// so we activate the integration synchronously from the configured env var
	// and return a redirect back to the same settings page.
	if (resolved.config.auth.type === 'api_key') {
		const body = (await c.req.json().catch(() => ({}))) as { api_key?: string }
		const apiKey = body.api_key
		if (!apiKey) {
			logger.error(`api_key provider ${providerName} missing request body api_key`)
			return c.json(
				createApiError('BAD_REQUEST', `Provider ${providerName} requires an API key`),
				400,
			)
		}

		const credentials: StoredCredentials = { accessToken: apiKey }
		const encryptedCredentials = encrypt(JSON.stringify(credentials))
		const externalId = `${providerName}-personal`

		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: providerName,
				status: 'active',
				externalId,
				credentials: encryptedCredentials,
				createdBy: actorId,
			})
			.onConflictDoUpdate({
				target: [integrations.workspaceId, integrations.provider, integrations.externalId],
				set: {
					status: 'active',
					credentials: encryptedCredentials,
					updatedAt: new Date(),
				},
			})
			.returning({ id: integrations.id })

		let integrationId = row?.id
		if (!integrationId) {
			const [existing] = await db
				.select({ id: integrations.id })
				.from(integrations)
				.where(
					and(
						eq(integrations.workspaceId, workspaceId),
						eq(integrations.provider, providerName),
						eq(integrations.externalId, externalId),
					),
				)
				.limit(1)
			integrationId = existing?.id
		}

		if (!integrationId) {
			logger.error('api_key integration activation returned no id', {
				provider: providerName,
				workspaceId,
			})
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to activate integration'), 500)
		}

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'integration',
			entityId: integrationId,
			data: { provider: providerName, external_id: externalId, auth_type: 'api_key' },
		})

		logger.info('api_key integration activated', {
			provider: providerName,
			workspaceId,
			integrationId,
		})

		const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
		return c.json({ install_url: `${frontendUrl}/${workspaceId}/settings/integrations` })
	}

	// manual providers have no OAuth redirect and no outbound-callable API key —
	// Maskin invents the credential handshake itself: mint an opaque routing
	// token now (embedded in the webhook URL we hand back), then wait for the
	// user to paste the provider-generated secret via POST /:id/complete.
	if (resolved.config.auth.type === 'manual') {
		const systemActorName = resolved.config.displayName
		let [systemActor] = await db
			.select()
			.from(actors)
			.where(and(eq(actors.type, 'system'), eq(actors.name, systemActorName)))
			.limit(1)

		if (!systemActor) {
			const [newActor] = await db
				.insert(actors)
				.values({
					type: 'system',
					name: systemActorName,
					apiKey: generateApiKey().key,
					createdBy: actorId,
				})
				.returning()
			if (!newActor) {
				return c.json(
					createApiError('INTERNAL_ERROR', 'Failed to create system actor for integration'),
					500,
				)
			}
			systemActor = newActor
		}

		const [existingMember] = await db
			.select()
			.from(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					eq(workspaceMembers.actorId, systemActor.id),
				),
			)
			.limit(1)

		if (!existingMember) {
			await db.insert(workspaceMembers).values({
				workspaceId,
				actorId: systemActor.id,
				role: 'system',
			})
		}

		const token = randomBytes(24).toString('hex')
		const activeConfig: IntegrationConfig = { system_actor_id: systemActor.id }

		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: providerName,
				status: 'awaiting_secret',
				externalId: token,
				credentials: '',
				config: activeConfig,
				createdBy: actorId,
			})
			.returning({ id: integrations.id })

		if (!row) {
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to create integration'), 500)
		}

		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'integration',
			entityId: row.id,
			data: { provider: providerName, external_id: token, auth_type: 'manual' },
		})

		const webhookUrl = `${resolvePublicOrigin(c.req.url, c.req.header())}/api/webhooks/${providerName}/${token}`
		return c.json({ webhook_url: webhookUrl, integration_id: row.id })
	}

	// Create signed state containing workspace + actor info + one-time nonce
	const nonce = randomBytes(16).toString('hex')
	const statePayload: Record<string, unknown> = {
		workspaceId,
		actorId,
		ts: Date.now(),
		nonce,
	}

	// If provider uses PKCE, generate and include code verifier in state
	if (resolved.config.auth.type === 'oauth2' && resolved.config.auth.config.pkce) {
		statePayload.codeVerifier = generateCodeVerifier()
	}

	const state = encrypt(JSON.stringify(statePayload))

	// Store the nonce in DB to prevent replay attacks. We intentionally avoid an
	// upsert here because the integrations table uses partial unique indexes, and
	// Postgres cannot infer those indexes from a plain ON CONFLICT target.
	try {
		await db.insert(integrations).values({
			workspaceId,
			provider: providerName,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})
	} catch (err) {
		if (
			typeof err === 'object' &&
			err !== null &&
			'code' in err &&
			(err as { code?: string }).code === '23505'
		) {
			logger.info(`Re-used pending integration nonce for ${providerName}`, {
				workspaceId,
				actorId,
				nonce,
			})
		} else {
			throw err
		}
	}
	// Build install URL based on auth type
	let installUrl: string
	if (resolved.customAuth) {
		installUrl = resolved.customAuth.getInstallUrl(state)
	} else if (resolved.config.auth.type === 'oauth2') {
		const redirectUri = buildRedirectUri(c.req.url, providerName, c.req.header())
		const handler = new OAuth2Handler(resolved.config.auth.config)
		installUrl = handler.createAuthorizationUrl(
			state,
			redirectUri,
			statePayload.codeVerifier as string | undefined,
		)
	} else {
		return c.json(
			createApiError('BAD_REQUEST', `Provider ${providerName} does not support OAuth connect`),
			400,
		)
	}

	return c.json({ install_url: installUrl })
}) as RouteHandler<typeof connectRoute, Env>)

// ── GET /api/integrations/:provider/callback ───────────────────────────────

const callbackRoute = createRoute({
	method: 'get',
	path: '/{provider}/callback',
	tags: ['integrations'],
	summary: 'OAuth/installation callback',
	request: {
		params: providerParamSchema,
	},
	responses: {
		302: { description: 'Redirect to frontend' },
		400: {
			description: 'Error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(callbackRoute, (async (c) => {
	const db = c.get('db')
	const { provider: providerName } = c.req.valid('param')
	const query = c.req.query()

	let resolved: ResolvedProvider
	try {
		resolved = getProvider(providerName)
	} catch {
		return c.json(createApiError('BAD_REQUEST', `Unknown provider: ${providerName}`), 400)
	}

	// Validate state
	const stateParam = query.state
	if (!stateParam) {
		return c.json(createApiError('BAD_REQUEST', 'Missing state parameter'), 400)
	}

	let stateData: {
		workspaceId: string
		actorId: string
		ts: number
		nonce: string
		codeVerifier?: string
	}
	try {
		stateData = JSON.parse(decrypt(stateParam))
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid state parameter'), 400)
	}

	// Check state age (max 10 minutes)
	if (Date.now() - stateData.ts > 10 * 60 * 1000) {
		return c.json(
			createApiError('BAD_REQUEST', 'State expired — please restart the connection flow'),
			400,
		)
	}

	// Verify one-time nonce to prevent replay attacks
	const [pendingIntegration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, stateData.workspaceId),
				eq(integrations.provider, providerName),
				eq(integrations.externalId, stateData.nonce),
				eq(integrations.status, 'pending'),
			),
		)
		.limit(1)

	if (!pendingIntegration) {
		return c.json(createApiError('BAD_REQUEST', 'Invalid or already used state token'), 400)
	}

	// Verify actor is still a workspace member
	const [member] = await db
		.select()
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, stateData.workspaceId),
				eq(workspaceMembers.actorId, stateData.actorId),
			),
		)
		.limit(1)

	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Actor is no longer a member of this workspace'), 400)
	}

	// Handle provider-specific callback
	let credentials: StoredCredentials
	try {
		if (resolved.customAuth) {
			credentials = await resolved.customAuth.handleCallback(query)
		} else if (resolved.config.auth.type === 'oauth2') {
			const code = query.code
			if (!code) {
				return c.json(createApiError('BAD_REQUEST', 'Missing authorization code'), 400)
			}
			const redirectUri = buildRedirectUri(c.req.url, providerName, c.req.header())
			const handler = new OAuth2Handler(resolved.config.auth.config, resolved.parseTokenResponse)
			credentials = await handler.exchangeCode(code, redirectUri, stateData.codeVerifier)
		} else {
			return c.json(createApiError('BAD_REQUEST', 'Provider does not support OAuth callback'), 400)
		}
	} catch (err) {
		logger.error(`OAuth callback token exchange failed for provider ${providerName}`, {
			workspaceId: stateData.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
		return c.redirect(
			`${frontendUrl}/${stateData.workspaceId}/settings/integrations?error=token_exchange_failed`,
		)
	}

	// Create or find system actor for this provider in the workspace
	const systemActorName = resolved.config.displayName
	let [systemActor] = await db
		.select()
		.from(actors)
		.where(and(eq(actors.type, 'system'), eq(actors.name, systemActorName)))
		.limit(1)

	if (!systemActor) {
		const [newActor] = await db
			.insert(actors)
			.values({
				type: 'system',
				name: systemActorName,
				apiKey: generateApiKey().key,
				createdBy: stateData.actorId,
			})
			.returning()
		if (!newActor) {
			return c.json(
				createApiError('INTERNAL_ERROR', 'Failed to create system actor for integration'),
				500,
			)
		}
		systemActor = newActor
	}

	// Ensure system actor is workspace member
	const [existingMember] = await db
		.select()
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, stateData.workspaceId),
				eq(workspaceMembers.actorId, systemActor.id),
			),
		)
		.limit(1)

	if (!existingMember) {
		await db.insert(workspaceMembers).values({
			workspaceId: stateData.workspaceId,
			actorId: systemActor.id,
			role: 'system',
		})
	}

	// Derive externalId — must match what extractInstallationId() finds in webhook payloads
	let externalId: string
	if (credentials.installation_id) {
		// Custom auth providers (e.g. GitHub) embed the ID directly in credentials
		externalId = String(credentials.installation_id)
	} else if (resolved.resolveExternalId) {
		// Standard OAuth2 providers resolve their identity via an API call (e.g. Slack auth.test → team_id)
		try {
			externalId = await resolved.resolveExternalId(credentials)
		} catch (err) {
			logger.error(`Failed to resolve external ID for provider ${providerName}`, {
				workspaceId: stateData.workspaceId,
				error: err instanceof Error ? err.message : String(err),
			})
			// Fall back to nonce-based ID so the integration still activates
			externalId = `oauth-${stateData.nonce.slice(0, 8)}`
		}
	} else {
		// No webhook matching needed — use nonce-based fallback
		externalId = `oauth-${stateData.nonce.slice(0, 8)}`
	}

	// GitHub-only: resolve the installation's owner login so the row can be
	// disambiguated from other installations on the same workspace. Failures fall
	// back to an undefined owner_login rather than blocking the connect — the row
	// is still useful for token/webhook routing.
	let ownerLogin: string | undefined
	if (credentials.installation_id) {
		try {
			ownerLogin = await fetchInstallationOwnerLogin(String(credentials.installation_id))
		} catch (err) {
			logger.warn(`Failed to fetch installation owner_login for ${providerName}`, {
				workspaceId: stateData.workspaceId,
				installationId: String(credentials.installation_id),
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	const encryptedCredentials = encrypt(JSON.stringify(credentials))
	const activeConfig: IntegrationConfig = { system_actor_id: systemActor.id }
	if (ownerLogin) activeConfig.owner_login = ownerLogin

	// Re-connecting an installation whose externalId is stable across connects
	// (GitHub installation ids, Slack team ids via resolveExternalId): refresh
	// the existing row in place — whatever its status — and drop the pending
	// nonce row. Without this, the UPDATE below trips the partial unique index
	// on (workspace_id, provider, external_id): a previous row for the same
	// installation — active, or revoked by a disconnect — blocks re-activation
	// with a 23505 at commit time. Nonce-derived externalIds are random per
	// connect and never collide, so this lookup simply misses for providers
	// without stable ids.
	let integrationId = pendingIntegration.id
	const [existingSameInstall] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, stateData.workspaceId),
				eq(integrations.provider, providerName),
				eq(integrations.externalId, externalId),
			),
		)
		.limit(1)

	if (existingSameInstall) {
		await db
			.update(integrations)
			.set({
				status: 'active',
				credentials: encryptedCredentials,
				config: activeConfig,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, existingSameInstall.id))

		await db.delete(integrations).where(eq(integrations.id, pendingIntegration.id))

		integrationId = existingSameInstall.id
		logger.info(`Refreshed existing ${providerName} installation`, {
			integrationId,
			workspaceId: stateData.workspaceId,
			externalId,
			previousStatus: existingSameInstall.status,
			ownerLogin,
		})
	} else {
		await db
			.update(integrations)
			.set({
				status: 'active',
				externalId,
				credentials: encryptedCredentials,
				config: activeConfig,
				updatedAt: new Date(),
			})
			.where(eq(integrations.id, integrationId))
	}

	// Provider-specific post-install work (e.g. Gmail's users.watch). Runs after the
	// row is active so postInstall can read the persisted config and append to it.
	if (resolved.postInstall) {
		try {
			await resolved.postInstall({
				db,
				integrationId,
				workspaceId: stateData.workspaceId,
				credentials,
			})
		} catch (err) {
			logger.error(`postInstall failed for provider ${providerName}`, {
				integrationId,
				error: err instanceof Error ? err.message : String(err),
			})
			// Mark the integration as failed so the user can retry. Don't 500 — let them
			// see the error in the UI redirect query string.
			await db
				.update(integrations)
				.set({ status: 'error', updatedAt: new Date() })
				.where(eq(integrations.id, integrationId))
			const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
			return c.redirect(
				`${frontendUrl}/${stateData.workspaceId}/settings/integrations?error=post_install_failed`,
			)
		}
	}

	// Log event
	await db.insert(events).values({
		workspaceId: stateData.workspaceId,
		actorId: stateData.actorId,
		action: 'created',
		entityType: 'integration',
		entityId: integrationId,
		data: {
			provider: providerName,
			external_id: externalId,
			...(ownerLogin ? { owner_login: ownerLogin } : {}),
		},
	})

	// Redirect to frontend settings/integrations page
	const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
	return c.redirect(`${frontendUrl}/${stateData.workspaceId}/settings/integrations`)
}) as RouteHandler<typeof callbackRoute, Env>)

// ── DELETE /api/integrations/:id ───────────────────────────────────────────

const deleteIntegrationRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['integrations'],
	summary: 'Disconnect an integration',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Integration disconnected',
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
		},
		404: {
			description: 'Integration not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(deleteIntegrationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [existing] = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)))
		.limit(1)
	if (!existing) return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)

	// Provider-specific cleanup before flipping status to 'revoked'. Runs while
	// credentials are still readable so the provider can call its remote API
	// (e.g. Gmail's users.stop) with a valid token. Provider implementations
	// are responsible for swallowing errors so disconnect always proceeds.
	//
	// Credentials are decrypted lazily (only when a preDisconnect hook exists) and
	// only for non-pending integrations — pending rows have credentials: '' because
	// the OAuth flow was never completed and there is nothing to revoke at the provider.
	try {
		const resolved = getProvider(existing.provider)
		if (resolved.preDisconnect && existing.status !== 'pending') {
			const credentials: StoredCredentials = JSON.parse(decrypt(existing.credentials))
			await resolved.preDisconnect({
				db,
				integrationId: existing.id,
				workspaceId: existing.workspaceId,
				credentials,
			})
		}
	} catch (err) {
		logger.warn(`preDisconnect failed for provider ${existing.provider}`, {
			integrationId: existing.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	await db.transaction(async (tx) => {
		await tx
			.update(integrations)
			.set({ status: 'revoked', updatedAt: new Date() })
			.where(eq(integrations.id, id))

		await tx.insert(events).values({
			workspaceId: existing.workspaceId,
			actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: { status: 'revoked', reason: 'user_disconnected' },
		})
	})

	return c.json({ deleted: true })
}) as RouteHandler<typeof deleteIntegrationRoute, Env>)

// ── POST /api/integrations/:id/complete ─────────────────────────────────────
// Finishes a manual-auth handshake: the user pastes the provider-generated
// secret (e.g. Skjald's per-webhook HMAC secret) into Maskin over an
// authenticated session, completing the row the connect route's 'manual'
// branch created with status 'awaiting_secret'.

const completeIntegrationRoute = createRoute({
	method: 'post',
	path: '/{id}/complete',
	tags: ['integrations'],
	summary: 'Complete a manual-auth integration handshake by supplying the provider secret',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Integration activated',
			content: { 'application/json': { schema: z.object({ activated: z.boolean() }) } },
		},
		400: {
			description: 'Error',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Integration not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(completeIntegrationRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const body = (await c.req.json().catch(() => ({}))) as { secret?: string }
	const secret = body.secret?.trim()
	if (!secret) {
		return c.json(createApiError('BAD_REQUEST', 'secret is required'), 400)
	}

	const [existing] = await db
		.select()
		.from(integrations)
		.where(and(eq(integrations.id, id), eq(integrations.workspaceId, workspaceId)))
		.limit(1)
	if (!existing) return c.json(createApiError('NOT_FOUND', 'Integration not found'), 404)

	const resolved = getProvider(existing.provider)
	if (resolved.config.auth.type !== 'manual') {
		return c.json(
			createApiError('BAD_REQUEST', `Provider ${existing.provider} does not use manual auth`),
			400,
		)
	}
	if (existing.status !== 'awaiting_secret') {
		return c.json(createApiError('BAD_REQUEST', 'Integration is not awaiting a secret'), 400)
	}

	await db.transaction(async (tx) => {
		await tx
			.update(integrations)
			.set({ credentials: encrypt(secret), status: 'active', updatedAt: new Date() })
			.where(eq(integrations.id, id))

		await tx.insert(events).values({
			workspaceId: existing.workspaceId,
			actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: id,
			data: { status: 'active', provider: existing.provider },
		})
	})

	return c.json({ activated: true })
}) as RouteHandler<typeof completeIntegrationRoute, Env>)

// ── GET /api/integrations/:id/github-token ─────────────────────────────────

const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

const githubTokenRoute = createRoute({
	method: 'get',
	path: '/{id}/github-token',
	tags: ['integrations'],
	summary: 'Mint a fresh GitHub App installation access token',
	request: {
		params: idParamSchema,
		query: z.object({
			repo: z
				.string()
				.optional()
				.openapi({
					description:
						'owner/name hint. When set AND GITHUB_APP_INSTALLATION_RECOVERY_ENABLED=true, ' +
						'a 404 on the cached installation id triggers re-discovery for this repo ' +
						'and mints against the fresh install (mid-session App-reinstall recovery). ' +
						'Ignored when the flag is off — behavior is identical to the legacy path.',
					example: 'sindre-ai/maskin',
				}),
		}),
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Freshly minted installation access token (1-hour GitHub-imposed TTL)',
			content: { 'application/json': { schema: z.object({ token: z.string() }) } },
		},
		400: {
			description: 'Failed to mint token',
			content: { 'application/json': { schema: errorSchema } },
		},
		401: {
			description: 'Integration authorization revoked',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'GitHub integration not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(githubTokenRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { repo } = c.req.valid('query')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [integration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.id, id),
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'github'),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	if (!integration) return c.json(createApiError('NOT_FOUND', 'GitHub integration not found'), 404)

	// Recovery path: on stale-cache 404 we re-discover the current install for
	// the target repo and mint against it, so an App reinstalled mid-session
	// doesn't surface raw 401 as a task failure. Gated by env flag (default off)
	// and requires a well-formed `?repo=owner/name` hint. The legacy path stays
	// unchanged when either is missing, so PAT-mode identities are unaffected
	// (they never reach this route in the first place — this is App-mode only).
	const recoveryEnabled = process.env.GITHUB_APP_INSTALLATION_RECOVERY_ENABLED === 'true'
	const recoveryRepo = recoveryEnabled && repo && REPO_SLUG_RE.test(repo) ? repo : undefined

	if (recoveryRepo) {
		try {
			const credentials: StoredCredentials = JSON.parse(decrypt(integration.credentials))
			const result = await mintInstallationTokenWithRecovery(credentials, { repo: recoveryRepo })
			if (result.recovered) {
				const oldInstallationId = credentials.installation_id as string | undefined
				if (oldInstallationId) {
					// Guard against concurrent-recovery duplicate audit rows: two parallel
					// callers can both 404 on the same cached id and both discover the
					// same new id. The helper takes a `SELECT … FOR UPDATE` on the row
					// so the second caller blocks on the first's lock, re-reads the
					// already-rotated value, and short-circuits without writing again.
					await persistRecoveredInstallationId(db, {
						integrationId: integration.id,
						workspaceId,
						actorId,
						expectedOldInstallationId: oldInstallationId,
						newInstallationId: result.installationId,
						repo: recoveryRepo,
					})
				}
				logger.info('Recovered GitHub App installation id mid-session', {
					integrationId: integration.id,
					oldInstallationId,
					newInstallationId: result.installationId,
					repo: recoveryRepo,
				})
			}
			return c.json({ token: result.token })
		} catch (err) {
			// Only a discovery 404 means "App is no longer installed for this
			// repo" — that's the case where the caller genuinely needs the
			// reconnect prompt. Every other discovery status (5xx, 429, network)
			// is a transient GitHub failure and must NOT tell the caller their
			// grant is revoked; it drops into the BAD_REQUEST branch so T5's
			// tagger classifies it as a transient failure instead.
			if (err instanceof DiscoveryError && err.status === 404) {
				logger.warn('GitHub App installation no longer resolvable — treating as revoked', {
					integrationId: integration.id,
					repo: recoveryRepo,
					error: err.message,
				})
				return c.json(
					createApiError(
						'AUTH_REVOKED',
						'GitHub App installation is no longer resolvable — please reconnect',
					),
					401,
				)
			}
			logger.warn('GitHub token mint failed (recovery path)', {
				integrationId: integration.id,
				repo: recoveryRepo,
				error: err instanceof Error ? err.message : String(err),
				...(err instanceof DiscoveryError ? { discovery_status: err.status } : {}),
			})
			return c.json(createApiError('BAD_REQUEST', 'Failed to mint GitHub access token'), 400)
		}
	}

	try {
		const provider = getProvider('github')
		const tokenManager = new TokenManager()
		// GitHub App installation tokens expire after exactly 1 hour with no refresh
		// token. getValidToken's customAuth branch mints a brand new one on every
		// call (no caching), so a caller hitting this route just-in-time always gets
		// a live token — unlike the value baked into a session's env vars once at
		// container launch, which goes stale for any session running past ~1 hour.
		const token = await tokenManager.getValidToken(db, integration.id, provider)
		return c.json({ token })
	} catch (err) {
		if (isAuthRevokedError(err)) {
			return c.json(
				createApiError(
					'AUTH_REVOKED',
					'GitHub integration authorization has been revoked — please reconnect',
				),
				401,
			)
		}
		logger.warn('GitHub token mint failed', {
			integrationId: integration.id,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('BAD_REQUEST', 'Failed to mint GitHub access token'), 400)
	}
}) as RouteHandler<typeof githubTokenRoute, Env>)

// ── GET /api/integrations/:id/slack/conversations ──────────────────────────

const slackConversationTypeSchema = z.enum(['public_channel', 'private_channel', 'im', 'mpim'])

const slackConversationSchema = z.object({
	id: z.string(),
	name: z.string(),
	is_private: z.boolean(),
	is_im: z.boolean(),
	is_mpim: z.boolean(),
	is_channel: z.boolean(),
})

const listSlackConversationsRoute = createRoute({
	method: 'get',
	path: '/{id}/slack/conversations',
	tags: ['integrations'],
	summary: 'List Slack conversations visible to the bot',
	request: {
		params: idParamSchema,
		query: z.object({
			types: z.string().optional().openapi({
				description: 'Comma-separated list of conversation types',
				example: 'public_channel,private_channel',
			}),
		}),
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'List of conversations',
			content: { 'application/json': { schema: z.array(slackConversationSchema) } },
		},
		400: {
			description: 'Bad request',
			content: { 'application/json': { schema: errorSchema } },
		},
		401: {
			description: 'Integration authorization revoked',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Integration not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listSlackConversationsRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const { types: typesParam } = c.req.valid('query')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [integration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.id, id),
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'slack'),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	if (!integration) return c.json(createApiError('NOT_FOUND', 'Slack integration not found'), 404)

	let types: SlackConversationType[]
	if (typesParam) {
		const parsed = typesParam.split(',').map((t) => t.trim())
		const validated = z.array(slackConversationTypeSchema).safeParse(parsed)
		if (!validated.success) {
			return c.json(createApiError('BAD_REQUEST', 'Invalid conversation types'), 400)
		}
		types = validated.data
	} else {
		types = ['public_channel', 'private_channel', 'im', 'mpim']
	}

	try {
		const provider = getProvider('slack')
		const tokenManager = new TokenManager()
		const accessToken = await tokenManager.getValidToken(db, integration.id, provider)
		const conversations = await listSlackConversations(integration.id, accessToken, types)
		return c.json(conversations)
	} catch (err) {
		if (isAuthRevokedError(err)) {
			return c.json(
				createApiError(
					'AUTH_REVOKED',
					'Slack integration authorization has been revoked — please reconnect',
				),
				401,
			)
		}
		logger.warn('Slack conversations.list failed', {
			integrationId: integration.id,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('BAD_REQUEST', 'Failed to fetch Slack conversations'), 400)
	}
}) as RouteHandler<typeof listSlackConversationsRoute, Env>)

// ── GET /api/integrations/:id/slack/users ──────────────────────────────────

const slackUserSchema = z.object({
	id: z.string(),
	name: z.string(),
	real_name: z.string(),
	is_bot: z.boolean(),
})

const listSlackUsersRoute = createRoute({
	method: 'get',
	path: '/{id}/slack/users',
	tags: ['integrations'],
	summary: 'List Slack users in the workspace',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'List of users',
			content: { 'application/json': { schema: z.array(slackUserSchema) } },
		},
		400: {
			description: 'Bad request',
			content: { 'application/json': { schema: errorSchema } },
		},
		401: {
			description: 'Integration authorization revoked',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Integration not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listSlackUsersRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [integration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.id, id),
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'slack'),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	if (!integration) return c.json(createApiError('NOT_FOUND', 'Slack integration not found'), 404)

	try {
		const provider = getProvider('slack')
		const tokenManager = new TokenManager()
		const accessToken = await tokenManager.getValidToken(db, integration.id, provider)
		const users = await listSlackUsers(integration.id, accessToken)
		return c.json(users)
	} catch (err) {
		if (isAuthRevokedError(err)) {
			return c.json(
				createApiError(
					'AUTH_REVOKED',
					'Slack integration authorization has been revoked — please reconnect',
				),
				401,
			)
		}
		logger.warn('Slack users.list failed', {
			integrationId: integration.id,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('BAD_REQUEST', 'Failed to fetch Slack users'), 400)
	}
}) as RouteHandler<typeof listSlackUsersRoute, Env>)

export default app

// ── Webhook handler (mounted separately at /api/webhooks) ──────────────────

// Slack entity types the normalizer emits for inbound user-to-agent traffic.
// `slack.app_mention` covers `@Maskin` in any channel; `slack.direct_message`
// covers DMs to the bot. Anything else (channel/group messages without an
// app_mention, reactions, channel events) is not what the ship metric is
// counting and stays untagged.
const SLACK_MENTION_ENTITY_TYPES = new Set(['slack.app_mention', 'slack.direct_message'])

function slackChannelType(entityType: string): 'channel' | 'group' | 'im' {
	if (entityType === 'slack.direct_message') return 'im'
	if (entityType === 'slack.group_message') return 'group'
	return 'channel'
}

function extractSlackTeamId(data: unknown): string | null {
	if (!data || typeof data !== 'object') return null
	const teamId = (data as Record<string, unknown>).team_id
	return typeof teamId === 'string' && teamId.length > 0 ? teamId : null
}

// Tag every Slack mention/DM event in `events` with `source: 'slack_mention'`,
// open the attribution window for the workspace, and emit the ship metric.
// Pure on non-Slack providers — returns the input unchanged so the cost on the
// rest of the webhook traffic stays zero.
function tagSlackMentionEventsAndEmit(
	providerName: string,
	normalizedEvents: NormalizedEvent[],
	workspaceId: string,
	systemActorId: string,
): NormalizedEvent[] {
	if (providerName !== 'slack') return normalizedEvents

	let emittedOnce = false
	return normalizedEvents.map((e) => {
		if (!SLACK_MENTION_ENTITY_TYPES.has(e.entityType)) return e

		// Open the in-memory attribution window once per delivery so T4's reply
		// path and T6's interactive edit handler can attach `source: 'slack_mention'`
		// to the object change they write inside the next 4h, without each call
		// site having to plumb the mention through.
		markSlackMention(workspaceId)

		// Emit the bet's ship metric exactly once per delivery — even if Slack
		// somehow delivered two mention events in one envelope, the ship metric
		// counts distinct deliveries, not distinct events. The PostHog capture is
		// fire-and-forget by contract (see `posthog.ts`), so failures here never
		// stall webhook ingest.
		if (!emittedOnce) {
			emittedOnce = true
			const slackTeamId = extractSlackTeamId(e.data)
			if (slackTeamId) {
				void trackSlackMentionReceived({
					workspaceId,
					actorId: systemActorId,
					channelType: slackChannelType(e.entityType),
					slackTeamId,
				})
			} else {
				logger.warn('Slack mention webhook missing team_id; skipping metric emit', {
					workspaceId,
					entityType: e.entityType,
				})
			}
		}

		return {
			...e,
			data: { ...(e.data as Record<string, unknown>), source: 'slack_mention' },
		}
	})
}

const webhookHandler = new WebhookHandler()

/**
 * Sentinel `workspace_id` used on `webhook_deliveries` rows for the Slack
 * interactive dedup ledger. Slack `trigger_id` is globally unique per
 * click; collapsing dedup to a single scope means a retry of the same
 * click is caught regardless of which maskin workspace the block_id
 * points at. The column is `notNull` with no FK, so a non-routable UUID
 * is safe.
 */
const SLACK_INTERACTIVE_DEDUP_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000'

export const webhookApp = new OpenAPIHono<Env>()

// ── Slack slash command: /maskin workspace <name> ─────────────────────────
//
// Slack POSTs form-encoded payloads here, signed with the same `v0` HMAC as
// the Events API. The literal route MUST be declared before `/:provider` so
// it wins over the catch-all param route.
//
// Per AC-U3 the slash command is the per-Slack-workspace override: it
// switches `slack_user_links.default_workspace_id` to the named Maskin
// workspace. Returns an immediate ephemeral via the response body — no
// follow-up POST to `response_url` needed for this surface.
webhookApp.post('/slack-commands', async (c) => {
	const db = c.get('db')
	const body = await c.req.text()

	const headers: Record<string, string> = {}
	for (const [key, value] of Object.entries(c.req.header())) {
		if (typeof value === 'string') headers[key.toLowerCase()] = value
	}

	const webhookConfig = slackProviderConfig.webhook
	if (!webhookConfig || 'type' in webhookConfig) {
		// Should be unreachable — slack config is always timestamp-scheme.
		return c.json(createApiError('INTERNAL_ERROR', 'Slack webhook config missing'), 500)
	}
	if (!webhookHandler.verify(webhookConfig, body, headers)) {
		logger.warn('Slack slash-command signature verification failed')
		return c.json(createApiError('UNAUTHORIZED', 'Invalid Slack signature'), 401)
	}

	const params = new URLSearchParams(body)
	const payload = {
		team_id: params.get('team_id') ?? undefined,
		user_id: params.get('user_id') ?? undefined,
		command: params.get('command') ?? undefined,
		text: params.get('text') ?? undefined,
		response_url: params.get('response_url') ?? undefined,
	}

	const result = await dispatchMaskinWorkspaceCommand(db, payload)
	// Slack expects either {text} (channel-visible) or {response_type:'ephemeral', text}.
	// Ephemeral is the safe default for personal routing decisions.
	return c.json({ response_type: 'ephemeral', text: result.responseText })
})

// ── Slack account-link interactivity ──────────────────────────────────────
//
// Slack POSTs Block Kit `block_actions` payloads here when the user interacts
// with the account-link picker (form-encoded with a `payload` field). The
// dispatcher returns 200 with an ephemeral body so Slack's 3s timeout is
// always met.
webhookApp.post('/slack-actions-account-link', async (c) => {
	const db = c.get('db')
	const body = await c.req.text()

	const headers: Record<string, string> = {}
	for (const [key, value] of Object.entries(c.req.header())) {
		if (typeof value === 'string') headers[key.toLowerCase()] = value
	}

	const webhookConfig = slackProviderConfig.webhook
	if (!webhookConfig || 'type' in webhookConfig) {
		return c.json(createApiError('INTERNAL_ERROR', 'Slack webhook config missing'), 500)
	}
	if (!webhookHandler.verify(webhookConfig, body, headers)) {
		logger.warn('Slack interactive signature verification failed')
		return c.json(createApiError('UNAUTHORIZED', 'Invalid Slack signature'), 401)
	}

	const params = new URLSearchParams(body)
	const rawPayload = params.get('payload')
	if (!rawPayload) {
		return c.json({ response_type: 'ephemeral', text: 'Missing payload.' })
	}
	let payload: Record<string, unknown>
	try {
		payload = JSON.parse(rawPayload) as Record<string, unknown>
	} catch {
		return c.json({ response_type: 'ephemeral', text: 'Could not parse Slack payload.' })
	}

	const result = await dispatchAccountLinkAction(db, payload)
	if (result.kind === 'unhandled') {
		return c.json({})
	}
	const text =
		result.message ??
		(result.kind === 'linked'
			? 'Linked.'
			: result.kind === 'noop'
				? 'OK.'
				: 'Could not complete account-link.')
	return c.json({ response_type: 'ephemeral', replace_original: false, text })
})

// Slack Interactivity Request URL. Registered before the generic
// `/:provider` route so the path-literal wins over the param. Slack signs
// these the same way as Events API POSTs (`v0=...` over
// `v0:{timestamp}:{body}`) but the body is `application/x-www-form-urlencoded`
// with a single `payload` field, not JSON. See
// `lib/integrations/providers/slack/interactive.ts` for the contract the
// unfurl pipeline (T5) emits.
webhookApp.post('/slack-interactive', async (c) => {
	const db = c.get('db')

	const body = await c.req.text()

	const headers: Record<string, string> = {}
	for (const [key, value] of Object.entries(c.req.header())) {
		if (typeof value === 'string') headers[key.toLowerCase()] = value
	}

	let slackProvider: ResolvedProvider
	try {
		slackProvider = getProvider('slack')
	} catch {
		return c.json(createApiError('INTERNAL_ERROR', 'Slack provider not registered'), 500)
	}

	const webhookConfig = slackProvider.config.webhook
	if (!webhookConfig || 'type' in webhookConfig) {
		return c.json(createApiError('INTERNAL_ERROR', 'Slack provider webhook config missing'), 500)
	}

	if (!webhookHandler.verify(webhookConfig, body, headers)) {
		logger.warn('Slack interactive: signature verification failed')
		return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
	}

	const payload = parseSlackInteractivePayload(body)
	if (!payload) {
		// Unparseable payload: ack 200 so Slack doesn't retry into the same wall.
		return c.json({ ok: true, skipped: 'unparseable' })
	}

	// Best-effort dedup. Slack retries interactive POSTs on any non-2xx
	// response inside 3s; `trigger_id` is unique per click, so a retry that
	// reaches us after we've already committed the side-effect is caught
	// here and short-circuited before we double-fire the audit event.
	const deliveryId = slackInteractiveDeliveryId(payload)
	const dedupWorkspaceId = SLACK_INTERACTIVE_DEDUP_WORKSPACE_ID

	if (deliveryId) {
		try {
			const rows = await db
				.insert(webhookDeliveries)
				.values({
					provider: 'slack-interactive',
					externalId: deliveryId,
					workspaceId: dedupWorkspaceId,
					processedAt: new Date(),
				})
				.onConflictDoNothing({
					target: [
						webhookDeliveries.provider,
						webhookDeliveries.externalId,
						webhookDeliveries.workspaceId,
					],
				})
				.returning({ id: webhookDeliveries.id })

			if (rows.length === 0) {
				logger.info('Slack interactive: duplicate delivery short-circuited', {
					deliveryId,
				})
				return c.json({ ok: true, skipped: 'duplicate' })
			}
		} catch (err) {
			// Fail-open: a dedup outage must not block legitimate user actions.
			logger.error('Slack interactive: dedup claim failed; processing without dedup', {
				deliveryId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	// The account-link picker (T2) posts its block_actions to this same URL —
	// a Slack app has exactly one Interactivity Request URL, so both surfaces
	// share it. Route by block ownership: picker payloads go to the link
	// dispatcher, everything else falls through to the object-edit handler.
	if (ownsAccountLinkInteraction(payload)) {
		try {
			const linkResult = await dispatchAccountLinkAction(
				db,
				payload as Parameters<typeof dispatchAccountLinkAction>[1],
			)
			// `noop` covers picker interactions before the confirm click (select,
			// checkbox) — no feedback wanted. Slack ignores the HTTP body on
			// block_actions POSTs, so visible feedback must go via response_url.
			if (linkResult.kind !== 'noop' && linkResult.kind !== 'unhandled' && payload.response_url) {
				await sendEphemeralResponse(payload.response_url, {
					text:
						linkResult.message ??
						(linkResult.kind === 'linked'
							? 'Linked your Maskin account.'
							: 'Could not complete account-link.'),
				})
			}
		} catch (err) {
			logger.error('Slack interactive: account-link dispatch crashed', {
				error: err instanceof Error ? err.message : String(err),
			})
			// Ack 200 either way — Slack retries on non-2xx and the retry would
			// hit the same crash.
		}
		return c.json({ ok: true })
	}

	try {
		const result = await handleSlackInteractivePayload(db, payload)
		if (result.updated) {
			logger.info('Slack interactive: object change committed', {
				workspaceId: result.workspaceId,
				objectId: result.objectId,
				actorId: result.actorId,
			})
		}
	} catch (err) {
		logger.error('Slack interactive: handler crashed', {
			error: err instanceof Error ? err.message : String(err),
		})
		// Still ack 200 so Slack doesn't retry — a retry would hit the same
		// crash and the user already saw their selection land in the picker.
	}

	return c.json({ ok: true })
})

// ── Skjald meeting-completed webhook ────────────────────────────────────────
// Registered before the generic `/:provider` catch-all so this path-literal
// route wins. Skjald has no central app-level secret — every desktop install
// mints its own locally — so this bypasses the generic single-secret
// verifier entirely: `:token` is the opaque routing factor minted by the
// `manual` connect branch (identifies the integrations row / workspace), and
// the per-row decrypted `credentials` is the authentication factor, checked
// directly via `verifyTimestampSignature()` against Skjald's known signing
// scheme (frontend/src-tauri/src/webhooks/signing.rs: `sha256=<hex>` over
// `"{timestamp}.{body}"`).
webhookApp.post('/skjald/:token', async (c) => {
	const db = c.get('db')
	const token = c.req.param('token')

	const [integration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, 'skjald'),
				eq(integrations.externalId, token),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)

	if (!integration) {
		return c.json(createApiError('NOT_FOUND', 'Unknown webhook'), 404)
	}

	const body = await c.req.text()
	const headers: Record<string, string> = {}
	for (const [key, value] of Object.entries(c.req.header())) {
		if (typeof value === 'string') headers[key.toLowerCase()] = value
	}

	const secret = decrypt(integration.credentials)
	const verified = verifyTimestampSignature(body, headers, secret, {
		signatureHeader: 'x-skjald-signature',
		timestampHeader: 'x-skjald-timestamp',
		bodyTemplate: '{timestamp}.{body}',
		signaturePrefix: 'sha256=',
		maxAgeSeconds: 300,
	})
	if (!verified) {
		logger.warn('Skjald webhook: signature verification failed', { integrationId: integration.id })
		return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
	}

	const integrationConfig = integration.config as IntegrationConfig
	const systemActorId = integrationConfig?.system_actor_id
	if (!systemActorId) {
		logger.error('Skjald webhook: integration missing system_actor_id', {
			integrationId: integration.id,
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Integration misconfigured'), 500)
	}

	let payload: unknown
	try {
		payload = JSON.parse(body)
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON'), 400)
	}

	const eventType = headers['x-skjald-event']
	const deliveryId = headers['x-skjald-delivery-id'] ?? null

	// Claim the delivery before processing so a retry that arrives while this
	// request is still in flight is recognised as a duplicate — same dedup
	// pattern the generic `/:provider` route uses via `extractDeliveryId`.
	let claimRowId: string | null = null
	if (deliveryId) {
		try {
			const rows = await db
				.insert(webhookDeliveries)
				.values({
					provider: 'skjald',
					externalId: deliveryId,
					workspaceId: integration.workspaceId,
				})
				.onConflictDoNothing({
					target: [
						webhookDeliveries.provider,
						webhookDeliveries.externalId,
						webhookDeliveries.workspaceId,
					],
				})
				.returning({ id: webhookDeliveries.id })
			if (rows.length === 0) {
				logger.info('Skipping duplicate skjald delivery', {
					deliveryId,
					workspaceId: integration.workspaceId,
				})
				return c.json({ ok: true, skipped: true })
			}
			claimRowId = rows[0]?.id ?? null
		} catch (err) {
			// Fail open: dedup-table outage must not stop us processing.
			logger.error('Failed to claim skjald delivery; processing without dedup', {
				deliveryId,
				workspaceId: integration.workspaceId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	const releaseClaim = async () => {
		if (!claimRowId) return
		try {
			await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, claimRowId))
		} catch (err) {
			logger.error('Failed to release skjald webhook delivery claim', {
				deliveryId,
				workspaceId: integration.workspaceId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	if (eventType !== 'transcription.completed') {
		// Unknown/future event type — ack without processing so Skjald doesn't retry.
		await releaseClaim()
		return c.json({ ok: true, skipped: 'unhandled_event' })
	}

	const parsedPayload = skjaldTranscriptionCompletedPayloadSchema.safeParse(payload)
	if (!parsedPayload.success) {
		await releaseClaim()
		return c.json(createApiError('BAD_REQUEST', 'Invalid transcription.completed payload'), 400)
	}

	try {
		const result = await upsertSkjaldMeeting(db, {
			workspaceId: integration.workspaceId,
			systemActorId,
			payload: parsedPayload.data,
		})

		await commitWebhookDelivery(db, {
			eventRows: [
				{
					workspaceId: integration.workspaceId,
					actorId: systemActorId,
					action: result.action,
					entityType: 'meeting',
					entityId: result.objectId,
					data: payload as Record<string, unknown>,
				},
			],
			claimRowId,
		})

		return c.json({ ok: true })
	} catch (err) {
		if (err instanceof ClaimReleasedError) {
			logger.warn('Skjald webhook claim gone or already processed at commit time; txn aborted', {
				integrationId: integration.id,
				workspaceId: integration.workspaceId,
				deliveryId,
				claimRowId: err.claimRowId,
			})
			return c.json({ ok: true, skipped: true })
		}
		logger.error('Skjald webhook processing failed', {
			integrationId: integration.id,
			workspaceId: integration.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		await releaseClaim()
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to process webhook'), 500)
	}
})

// `asyncProcessing` providers (Slack) hand fan-out + events insert off to the
// event loop so the route can ack fast — the caller never gets a handle on
// that background promise. Track it here so integration tests (running
// against real Postgres, where the work is genuine socket I/O spanning many
// event-loop turns, not a single microtask) can deterministically wait for it
// instead of racing an arbitrary number of `setImmediate`/timer ticks.
const pendingAsyncWebhookWork = new Set<Promise<unknown>>()

/** Exported for tests only — await all in-flight asyncProcessing work. */
export async function __flushAsyncWebhookProcessingForTests(): Promise<void> {
	await Promise.all(pendingAsyncWebhookWork)
}

webhookApp.post('/:provider', async (c) => {
	const db = c.get('db')
	const providerName = c.req.param('provider')

	let resolved: ResolvedProvider
	try {
		resolved = getProvider(providerName)
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Unknown provider'), 400)
	}

	// Read raw body for signature verification
	const body = await c.req.text()

	// Build lowercase headers map
	const headers: Record<string, string> = {}
	for (const [key, value] of Object.entries(c.req.header())) {
		if (typeof value === 'string') headers[key.toLowerCase()] = value
	}

	// Verify webhook signature using provider's config
	const webhookConfig = resolved.config.webhook
	if (!webhookConfig) {
		return c.json(createApiError('BAD_REQUEST', 'Provider does not support webhooks'), 400)
	}

	if ('type' in webhookConfig) {
		if (!resolved.customWebhookVerifier) {
			logger.error(`Provider ${providerName} uses custom webhook but has no customWebhookVerifier`)
			return c.json(createApiError('INTERNAL_ERROR', 'Webhook verification not configured'), 500)
		}
		const verified = await resolved.customWebhookVerifier(body, headers)
		if (!verified) {
			logger.warn(`Custom webhook verification failed for ${providerName}`)
			return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
		}
	} else {
		if (!webhookHandler.verify(webhookConfig, body, headers)) {
			logger.warn(`Webhook signature verification failed for ${providerName}`)
			return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
		}
	}

	// Parse and normalize
	let payload: unknown
	try {
		payload = JSON.parse(body)
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON payload'), 400)
	}

	// Allow provider to short-circuit (e.g. Slack url_verification challenge)
	if (resolved.webhookPreHandler) {
		const preResponse = resolved.webhookPreHandler(payload, headers)
		if (preResponse) return c.json(preResponse.body, (preResponse.status ?? 200) as 200)
	}

	const normalized = normalizeEvent(resolved, payload, headers)
	if (!normalized) {
		// Event type we don't handle — acknowledge it
		return c.json({ ok: true, skipped: true })
	}

	// Find ALL matching active integrations. A single external install (e.g. one
	// Slack team) can be connected to multiple Maskin workspaces, and each one
	// needs its own copy of the event so per-workspace triggers fire correctly.
	// `.limit(1)` here used to silently starve every workspace except whichever
	// row Postgres returned first.
	const matchingIntegrations = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, providerName),
				eq(integrations.externalId, normalized.installationId),
				eq(integrations.status, 'active'),
			),
		)

	if (matchingIntegrations.length === 0) {
		// No matching integration — might be uninstalled
		return c.json({ ok: true, skipped: true })
	}

	const eligible = matchingIntegrations.filter((integration) => {
		const config = integration.config as IntegrationConfig
		if (!config?.system_actor_id) {
			logger.warn(`Integration ${integration.id} missing system_actor_id in config`)
			return false
		}
		return true
	})

	if (eligible.length === 0) {
		return c.json({ ok: true, skipped: true })
	}

	// Slack DM vs channel identity split (AC-U1, AC-T2). Every candidate
	// integration bound to this Slack team is a channel-surface target; a DM
	// gets narrowed to the mentioning user's `slack_user_links` workspace, or
	// dropped with an AC-U5 re-link prompt if no personal link exists. Channel
	// mentions pass through unchanged so multi-workspace fan-out still lands
	// one event per bound workspace.
	let dispatchList = eligible
	if (providerName === 'slack') {
		const surface = getMentionSurface(normalized)
		if (surface !== null) {
			const slackUserId = extractMentioningSlackUserId(normalized)
			const slackTeamId = normalized.installationId
			const channelId = extractChannelId(normalized)
			if (slackUserId && slackTeamId) {
				const resolution = await resolveMentionDispatch(
					db,
					slackTeamId,
					slackUserId,
					surface,
					eligible,
				)
				dispatchList = resolution.targets
				if (resolution.needsRelinkPrompt && channelId) {
					// DM landed with no personal link — post the re-link picker so the
					// user can pick a workspace explicitly (AC-U5), then drop the
					// event. Any active integration for the team owns a bot token
					// that can post the ephemeral (bot tokens are team-scoped on
					// Slack's side), so we prompt off the first eligible one.
					const promptIntegration = eligible[0]
					if (promptIntegration) {
						const frontendUrl = process.env.FRONTEND_URL || 'https://maskin.io'
						const promptTask = maybePromptAccountLink({
							db,
							integrationId: promptIntegration.id,
							integrationCredentials: promptIntegration.credentials,
							slackTeamId,
							slackUserId,
							channelId,
							frontendUrl,
						})
							.catch((err) => {
								logger.warn('Slack DM re-link prompt failed', {
									integrationId: promptIntegration.id,
									slackTeamId,
									slackUserId,
									error: err instanceof Error ? err.message : String(err),
								})
							})
							.finally(() => {
								pendingAsyncWebhookWork.delete(promptTask)
							})
						pendingAsyncWebhookWork.add(promptTask)
					}
				}
			}
		}
	}

	if (dispatchList.length === 0) {
		return c.json({ ok: true, skipped: true })
	}

	// Some providers (Gmail) deliver pointer-style webhooks where one push expands
	// into N concrete events. webhookFanOut returns the list to insert; if absent
	// we insert the single normalized event as-is. Run fan-out per integration so
	// each workspace gets its own copy and a slow/failing fan-out for one workspace
	// doesn't drop another workspace's event.
	const deliveryId = resolved.extractDeliveryId?.(payload, headers)
	const storageProvider = c.get('storageProvider')

	type Outcome =
		| { kind: 'inserted'; count: number }
		| { kind: 'duplicate' }
		| { kind: 'failed' }
		| { kind: 'queued' }

	const asyncProcessing = resolved.asyncProcessing === true

	const perWorkspaceResults: Outcome[] = await Promise.all(
		dispatchList.map(async (integration): Promise<Outcome> => {
			const config = integration.config as IntegrationConfig
			const systemActorId = config.system_actor_id as string

			// Claim the delivery BEFORE running fan-out. webhookFanOut can do expensive
			// network work (Gmail's users.history.list, Slack file downloads, etc.) and
			// running it before dedup means every retry would redo that work until the
			// claim caught it. The schema comment on webhook_deliveries calls this out
			// directly — the ledger is meant to prevent duplicate downloaded files too,
			// not just duplicate events.
			let claimRowId: string | null = null
			if (deliveryId) {
				try {
					const rows = await db
						.insert(webhookDeliveries)
						.values({
							provider: providerName,
							externalId: deliveryId,
							workspaceId: integration.workspaceId,
						})
						.onConflictDoNothing({
							target: [
								webhookDeliveries.provider,
								webhookDeliveries.externalId,
								webhookDeliveries.workspaceId,
							],
						})
						.returning({ id: webhookDeliveries.id })
					if (rows.length === 0) {
						logger.info(`Skipping duplicate ${providerName} delivery for workspace`, {
							deliveryId,
							workspaceId: integration.workspaceId,
						})
						return { kind: 'duplicate' }
					}
					claimRowId = rows[0]?.id ?? null
				} catch (err) {
					// Fail open: a dedup-table outage must not stop us from processing.
					logger.error(`Failed to claim ${providerName} delivery; processing without dedup`, {
						deliveryId,
						workspaceId: integration.workspaceId,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			// Release the claim if anything downstream fails. Without this, a thrown
			// fan-out or event insert (e.g. PG NOTIFY's 8KB rejection, see
			// .claude/rules/known-pitfalls.md) would leave the claim committed and
			// permanently starve provider retries for this workspace.
			const releaseClaim = async () => {
				if (!claimRowId) return
				try {
					await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, claimRowId))
				} catch (err) {
					// Best-effort: if this fails the reconciler will pick the orphan up
					// after the stale threshold elapses. Logged loudly so on-call sees it.
					logger.error(`Failed to release webhook delivery claim for ${providerName}`, {
						deliveryId,
						workspaceId: integration.workspaceId,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}

			const runFanOutAndInsert = async (): Promise<Outcome> => {
				let toInsert = [normalized]
				if (resolved.webhookFanOut) {
					try {
						toInsert = await resolved.webhookFanOut({
							db,
							storage: storageProvider,
							integrationId: integration.id,
							workspaceId: integration.workspaceId,
							normalized,
						})
					} catch (err) {
						logger.error(`webhookFanOut failed for ${providerName}`, {
							integrationId: integration.id,
							workspaceId: integration.workspaceId,
							error: err instanceof Error ? err.message : String(err),
						})
						await releaseClaim()
						return { kind: 'failed' }
					}
				}

				if (toInsert.length === 0) return { kind: 'inserted', count: 0 }

				// Slack-app ship metric (T8 of bet/slack-app). Tag every inbound mention/DM
				// event with `source: 'slack_mention'` so downstream attribution joins can
				// be computed off the events table, open the in-memory attribution window
				// so T4's reply path and T6's interactive edit can carry the same tag, and
				// fire the PostHog ship metric once per dedup'd delivery. Skipped silently
				// when the event isn't a mention or the provider isn't Slack — keeps every
				// other webhook path byte-for-byte unchanged.
				toInsert = tagSlackMentionEventsAndEmit(
					providerName,
					toInsert,
					integration.workspaceId,
					systemActorId,
				)

				// Mark the claim processed in the SAME transaction as the events insert,
				// gated on the claim row still existing and being unprocessed. Without
				// the gate, a long fan-out (>STALE_THRESHOLD_MS) could race the
				// reconciler: the reconciler deletes the orphan, the route's UPDATE
				// matches 0 rows but the txn commits anyway, and an events row lands
				// without its provenance claim. Throwing on a 0-row UPDATE aborts the
				// txn so neither side commits — the provider's next retry reprocesses
				// cleanly.
				try {
					await commitWebhookDelivery(db, {
						eventRows: toInsert.map((e) => ({
							workspaceId: integration.workspaceId,
							actorId: systemActorId,
							action: e.action,
							entityType: e.entityType,
							entityId: integration.id,
							data: e.data,
						})),
						claimRowId,
					})
					return { kind: 'inserted', count: toInsert.length }
				} catch (err) {
					if (err instanceof ClaimReleasedError) {
						// Two cases land here: the reconciler deleted the claim during
						// fan-out, or another writer already set processed_at on it. Log
						// neutrally so on-call doesn't mis-attribute a double-processed
						// delivery to a reconciler race — claimRowId + deliveryId in the
						// structured fields are enough to tell them apart from logs.
						logger.warn(
							`Webhook claim gone or already processed for ${providerName} at commit time; txn aborted`,
							{
								integrationId: integration.id,
								workspaceId: integration.workspaceId,
								deliveryId,
								claimRowId: err.claimRowId,
							},
						)
						return { kind: 'failed' }
					}
					logger.error(`Event insert failed for ${providerName}`, {
						integrationId: integration.id,
						workspaceId: integration.workspaceId,
						error: err instanceof Error ? err.message : String(err),
					})
					await releaseClaim()
					return { kind: 'failed' }
				}
			}

			if (asyncProcessing) {
				// Hand fan-out + event insert off to the event loop so the route can ack
				// inside Slack's 3s budget regardless of file count or download latency.
				// The delivery claim above already committed, so a Slack retry that
				// arrives while this background task is still running is recognised as
				// a duplicate and skipped.
				const task = runFanOutAndInsert()
					.catch((err) => {
						logger.error(`Async ${providerName} processing crashed`, {
							integrationId: integration.id,
							workspaceId: integration.workspaceId,
							error: err instanceof Error ? err.message : String(err),
						})
					})
					.finally(() => {
						pendingAsyncWebhookWork.delete(task)
					})
				pendingAsyncWebhookWork.add(task)
				return { kind: 'queued' }
			}

			return runFanOutAndInsert()
		}),
	)

	const totalInserted = perWorkspaceResults.reduce(
		(sum, r) => sum + (r.kind === 'inserted' ? r.count : 0),
		0,
	)
	const totalQueued = perWorkspaceResults.filter((r) => r.kind === 'queued').length
	const allDuplicate =
		perWorkspaceResults.length > 0 && perWorkspaceResults.every((r) => r.kind === 'duplicate')

	if (allDuplicate) {
		return c.json({ ok: true, skipped: 'duplicate' })
	}

	if (totalQueued > 0) {
		logger.info(
			`Webhook queued: ${totalQueued} delivery(ies) for ${providerName} across ${eligible.length} workspace(s)`,
		)
		return c.json({ ok: true, queued: totalQueued, workspaces: eligible.length })
	}

	if (totalInserted === 0) {
		return c.json({ ok: true, skipped: true })
	}

	logger.info(
		`Webhook processed: ${totalInserted} event(s) for ${providerName} across ${eligible.length} workspace(s)`,
	)

	return c.json({ ok: true, count: totalInserted, workspaces: eligible.length })
})

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build the OAuth redirect URI, using CORS_ORIGIN when set to prevent header injection */
// In production, use the configured origin to prevent X-Forwarded-Host injection
function resolvePublicOrigin(
	requestUrl: string,
	headers: Record<string, string | undefined>,
): string {
	const corsOrigin = process.env.CORS_ORIGIN
	if (corsOrigin) {
		return (corsOrigin.split(',')[0] ?? corsOrigin).trim().replace(/\/$/, '')
	}

	// Fallback for local development
	const forwardedHost = headers['x-forwarded-host']
	const forwardedProto = headers['x-forwarded-proto']

	if (forwardedHost) {
		const proto = forwardedProto ?? 'https'
		return `${proto}://${forwardedHost}`
	}

	return new URL(requestUrl).origin
}

function buildRedirectUri(
	requestUrl: string,
	providerName: string,
	headers: Record<string, string | undefined>,
): string {
	return `${resolvePublicOrigin(requestUrl, headers)}/api/integrations/${providerName}/callback`
}
