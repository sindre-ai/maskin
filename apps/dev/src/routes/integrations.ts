import { randomBytes } from 'node:crypto'
import type { Database } from '@ai-native/db'
import { events, actors, integrations, workspaceMembers } from '@ai-native/db/schema'
import type { PgNotifyBridge } from '@ai-native/realtime'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError } from '../lib/errors'
import { normalizeEvent } from '../lib/integrations/events/normalizer'
import { OAuth2Handler } from '../lib/integrations/oauth/handler'
import { generateCodeVerifier } from '../lib/integrations/oauth/pkce'
import { getProvider, listProviders } from '../lib/integrations/registry'
import type { ResolvedProvider, StoredCredentials } from '../lib/integrations/types'
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

	// Store nonce in DB to prevent replay attacks
	await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: providerName,
			status: 'pending',
			externalId: nonce,
			credentials: '',
			createdBy: actorId,
		})
		.onConflictDoUpdate({
			target: [integrations.workspaceId, integrations.provider],
			set: {
				externalId: nonce,
				status: 'pending',
				updatedAt: new Date(),
			},
		})

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
			return c.json(
				createApiError('BAD_REQUEST', 'Provider does not support OAuth callback'),
				400,
			)
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

	// Activate the pending integration (consumes the nonce)
	const encryptedCredentials = encrypt(JSON.stringify(credentials))
	const integrationId = pendingIntegration.id

	await db
		.update(integrations)
		.set({
			status: 'active',
			externalId,
			credentials: encryptedCredentials,
			config: { system_actor_id: systemActor.id },
			updatedAt: new Date(),
		})
		.where(eq(integrations.id, integrationId))

	// Log event
	await db.insert(events).values({
		workspaceId: stateData.workspaceId,
		actorId: stateData.actorId,
		action: 'created',
		entityType: 'integration',
		entityId: integrationId,
		data: { provider: providerName, external_id: externalId },
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

	await db
		.update(integrations)
		.set({ status: 'revoked', updatedAt: new Date() })
		.where(eq(integrations.id, id))

	return c.json({ deleted: true })
}) as RouteHandler<typeof deleteIntegrationRoute, Env>)

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
		if (!resolved.customWebhookVerifier(body, headers)) {
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

	const normalized = normalizeEvent(resolved, payload, headers)
	if (!normalized) {
		// Event type we don't handle — acknowledge it
		return c.json({ ok: true, skipped: true })
	}

	// Find integration by provider + installation ID
	const [integration] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.provider, providerName),
				eq(integrations.externalId, normalized.installationId),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)

	if (!integration) {
		// No matching integration — might be uninstalled
		return c.json({ ok: true, skipped: true })
	}

	const config = integration.config as IntegrationConfig
	const systemActorId = config?.system_actor_id

	if (!systemActorId) {
		logger.warn(`Integration ${integration.id} missing system_actor_id in config`)
		return c.json({ ok: true, skipped: true })
	}

	// Insert into events table — PG NOTIFY fires automatically
	await db.insert(events).values({
		workspaceId: integration.workspaceId,
		actorId: systemActorId,
		action: normalized.action,
		entityType: normalized.entityType,
		entityId: integration.id,
		data: normalized.data,
	})

	logger.info(
		`Webhook processed: ${normalized.entityType}.${normalized.action} for workspace ${integration.workspaceId}`,
	)

	return c.json({ ok: true })
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
		const origin = corsOrigin.split(',')[0].trim().replace(/\/$/, '')
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
