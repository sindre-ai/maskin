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
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError } from '../lib/errors'
import { normalizeEvent } from '../lib/integrations/events/normalizer'
import { OAuth2Handler } from '../lib/integrations/oauth/handler'
import { generateCodeVerifier } from '../lib/integrations/oauth/pkce'
import { TokenManager } from '../lib/integrations/oauth/token-manager'
import { fetchInstallationOwnerLogin } from '../lib/integrations/providers/github/auth'
import {
	type SlackConversationType,
	listSlackConversations,
	listSlackUsers,
} from '../lib/integrations/providers/slack/client'
import { getProvider, listProviders } from '../lib/integrations/registry'
import type { ResolvedProvider, StoredCredentials } from '../lib/integrations/types'
import { isAuthRevokedError } from '../lib/integrations/errors'
import { ClaimReleasedError, commitWebhookDelivery } from '../lib/integrations/webhooks/commit'
import { WebhookHandler } from '../lib/integrations/webhooks/handler'
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
			description: 'Install URL for OAuth/GitHub App',
			content: { 'application/json': { schema: z.object({ install_url: z.string() }) } },
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

	// Re-connecting an already-active installation: refresh the existing row in
	// place and drop the pending nonce row. Without this, we'd UPDATE the pending
	// row to externalId=installation_id and hit the (workspace_id, provider,
	// external_id) unique constraint at commit time. Only meaningful for providers
	// whose externalId is stable across connects (GitHub installations); standard
	// OAuth2 nonce-derived externalIds can't collide.
	let integrationId = pendingIntegration.id
	if (credentials.installation_id) {
		const [existingActive] = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, stateData.workspaceId),
					eq(integrations.provider, providerName),
					eq(integrations.externalId, externalId),
					eq(integrations.status, 'active'),
				),
			)
			.limit(1)

		if (existingActive) {
			await db
				.update(integrations)
				.set({
					credentials: encryptedCredentials,
					config: activeConfig,
					updatedAt: new Date(),
				})
				.where(eq(integrations.id, existingActive.id))

			await db.delete(integrations).where(eq(integrations.id, pendingIntegration.id))

			integrationId = existingActive.id
			logger.info(`Refreshed existing ${providerName} installation`, {
				integrationId,
				workspaceId: stateData.workspaceId,
				externalId,
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
	try {
		const resolved = getProvider(existing.provider)
		if (resolved.preDisconnect) {
			await resolved.preDisconnect({
				db,
				integrationId: existing.id,
				workspaceId: existing.workspaceId,
			})
		}
	} catch (err) {
		logger.warn(`preDisconnect failed for provider ${existing.provider}`, {
			integrationId: existing.id,
			error: err instanceof Error ? err.message : String(err),
		})
	}

	await db
		.update(integrations)
		.set({ status: 'revoked', updatedAt: new Date() })
		.where(eq(integrations.id, id))

	return c.json({ deleted: true })
}) as RouteHandler<typeof deleteIntegrationRoute, Env>)

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
			return c.json(createApiError('AUTH_REVOKED', 'Slack integration authorization has been revoked — please reconnect'), 401)
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
			return c.json(createApiError('AUTH_REVOKED', 'Slack integration authorization has been revoked — please reconnect'), 401)
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

const webhookHandler = new WebhookHandler()

export const webhookApp = new OpenAPIHono<Env>()

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
		eligible.map(async (integration): Promise<Outcome> => {
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
				void runFanOutAndInsert().catch((err) => {
					logger.error(`Async ${providerName} processing crashed`, {
						integrationId: integration.id,
						workspaceId: integration.workspaceId,
						error: err instanceof Error ? err.message : String(err),
					})
				})
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
function buildRedirectUri(
	requestUrl: string,
	providerName: string,
	headers: Record<string, string | undefined>,
): string {
	// In production, use the configured origin to prevent X-Forwarded-Host injection
	const corsOrigin = process.env.CORS_ORIGIN
	if (corsOrigin) {
		const origin = (corsOrigin.split(',')[0] ?? corsOrigin).trim().replace(/\/$/, '')
		return `${origin}/api/integrations/${providerName}/callback`
	}

	// Fallback for local development
	const forwardedHost = headers['x-forwarded-host']
	const forwardedProto = headers['x-forwarded-proto']

	let origin: string
	if (forwardedHost) {
		const proto = forwardedProto ?? 'https'
		origin = `${proto}://${forwardedHost}`
	} else {
		const url = new URL(requestUrl)
		origin = url.origin
	}

	return `${origin}/api/integrations/${providerName}/callback`
}
