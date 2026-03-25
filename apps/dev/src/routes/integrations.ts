import { randomBytes } from 'node:crypto'
import type { Database } from '@ai-native/db'
import { events, actors, integrations, workspaceMembers } from '@ai-native/db/schema'
import type { PgNotifyBridge } from '@ai-native/realtime'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError } from '../lib/errors'
import { getProvider, listProviders } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import {
	errorSchema,
	idParamSchema,
	integrationResponseSchema,
	providerInfoSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serializeArray } from '../lib/serialize'

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
		name: p.name,
		displayName: p.displayName,
		events: p.getAvailableEvents(),
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

	let provider: ReturnType<typeof getProvider>
	try {
		provider = getProvider(providerName)
	} catch {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				`Unknown provider: ${providerName}`,
				undefined,
				`Available providers: ${listProviders()
					.map((p) => p.name)
					.join(', ')}`,
			),
			400,
		)
	}

	// Create signed state containing workspace + actor info + one-time nonce
	const nonce = randomBytes(16).toString('hex')
	const statePayload = JSON.stringify({
		workspaceId,
		actorId,
		ts: Date.now(),
		nonce,
	})
	const state = encrypt(statePayload)

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

	const installUrl = provider.getInstallUrl(state)
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

	let provider: ReturnType<typeof getProvider>
	try {
		provider = getProvider(providerName)
	} catch {
		return c.json(createApiError('BAD_REQUEST', `Unknown provider: ${providerName}`), 400)
	}

	// Validate state
	const stateParam = query.state
	if (!stateParam) {
		return c.json(createApiError('BAD_REQUEST', 'Missing state parameter'), 400)
	}

	let stateData: { workspaceId: string; actorId: string; ts: number; nonce: string }
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
	const credentials = await provider.handleCallback(query)

	// Create or find system actor for this provider in the workspace
	const systemActorName = provider.displayName
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
			throw new Error('Failed to create system actor')
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

	// Activate the pending integration (consumes the nonce)
	const encryptedCredentials = encrypt(JSON.stringify(credentials))
	const integrationId = pendingIntegration.id

	await db
		.update(integrations)
		.set({
			status: 'active',
			externalId: credentials.installation_id,
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
		data: { provider: providerName, installation_id: credentials.installation_id },
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

export const webhookApp = new OpenAPIHono<Env>()

webhookApp.post('/:provider', async (c) => {
	const db = c.get('db')
	const providerName = c.req.param('provider')

	let provider: ReturnType<typeof getProvider>
	try {
		provider = getProvider(providerName)
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Unknown provider'), 400)
	}

	// Read raw body for signature verification
	const body = await c.req.text()
	const signature = c.req.header('x-hub-signature-256') || ''

	if (!provider.verifyWebhook(body, signature)) {
		logger.warn(`Webhook signature verification failed for ${providerName}`)
		return c.json(createApiError('UNAUTHORIZED', 'Invalid webhook signature'), 401)
	}

	// Parse and normalize
	let payload: unknown
	try {
		payload = JSON.parse(body)
	} catch {
		return c.json(createApiError('BAD_REQUEST', 'Invalid JSON payload'), 400)
	}
	const headers: Record<string, string> = {}
	for (const [key, value] of Object.entries(c.req.header())) {
		if (typeof value === 'string') headers[key.toLowerCase()] = value
	}

	const normalized = provider.normalizeEvent(payload, headers)
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

	const config = integration.config as Record<string, unknown>
	const systemActorId = config?.system_actor_id as string

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
