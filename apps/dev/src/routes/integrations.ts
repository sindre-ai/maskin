import { randomBytes } from 'node:crypto'
import type { Database } from '@ai-native/db'
import {
	events,
	actors,
	integrations,
	objects,
	workspaceMembers,
	workspaces,
} from '@ai-native/db/schema'
import { processRecording } from '@ai-native/ext-notetaker/pipeline'
import {
	createCalendar,
	deleteBotFromEvent,
	listCalendarEvents,
	scheduleBotForEvent,
} from '@ai-native/ext-notetaker/recall'
import type { ModuleEnv } from '@ai-native/module-sdk'
import type { PgNotifyBridge } from '@ai-native/realtime'
import type { StorageProvider } from '@ai-native/storage'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { and, eq, sql } from 'drizzle-orm'
import { decrypt, encrypt } from '../lib/crypto'
import { createApiError } from '../lib/errors'
import { getEnvOrThrow } from '../lib/integrations/env'
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

	// Never expose credentials or internal providers
	const safe = results
		.filter((r) => {
			try {
				const provider = getProvider(r.provider)
				return !provider.config.internal
			} catch {
				return true
			}
		})
		.map((r) => {
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

	// Register calendar with Recall Calendar V2 for calendar providers
	if (providerName === 'google-calendar' || providerName === 'outlook-calendar') {
		try {
			const platform = providerName === 'google-calendar' ? 'google_calendar' : 'microsoft_outlook'
			const clientIdEnv =
				providerName === 'google-calendar' ? 'GOOGLE_CALENDAR_CLIENT_ID' : 'OUTLOOK_CLIENT_ID'
			const clientSecretEnv =
				providerName === 'google-calendar'
					? 'GOOGLE_CALENDAR_CLIENT_SECRET'
					: 'OUTLOOK_CLIENT_SECRET'

			if (credentials.refreshToken) {
				const recallCalendar = await createCalendar(
					platform as 'google_calendar' | 'microsoft_outlook',
					credentials.refreshToken,
					getEnvOrThrow(clientIdEnv),
					getEnvOrThrow(clientSecretEnv),
				)

				// Store recall_calendar_id in integration config
				await db
					.update(integrations)
					.set({
						config: {
							system_actor_id: systemActor.id,
							recall_calendar_id: recallCalendar.id,
						},
					})
					.where(eq(integrations.id, integrationId))

				logger.info('Registered calendar with Recall', {
					provider: providerName,
					recallCalendarId: recallCalendar.id,
					workspaceId: stateData.workspaceId,
				})
			}
		} catch (err) {
			logger.error('Failed to register calendar with Recall', {
				provider: providerName,
				workspaceId: stateData.workspaceId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

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

	// ── Recall-specific webhook handling ──────────────────────────────────
	// Recall is an internal provider — no per-entity integration record exists.
	// We look up context differently depending on the event type.
	if (providerName === 'recall') {
		return handleRecallWebhook(db, c, normalized)
	}

	// ── Generic provider webhook handling ─────────────────────────────────
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

// ── Recall webhook handler ─────────────────────────────────────────────────

import type { Context } from 'hono'
import type { NormalizedEvent } from '../lib/integrations/types'

async function handleRecallWebhook(db: Database, c: Context, normalized: NormalizedEvent) {
	// ── Calendar sync events: fetch changed events and schedule bots ──────
	if (normalized.entityType === 'recall.calendar' && normalized.action === 'sync_events') {
		const calendarId = normalized.data.calendar_id as string
		const lastUpdatedTs = normalized.data.last_updated_ts as string | null

		// Find the calendar integration by recall_calendar_id in config
		const [integration] = await db
			.select()
			.from(integrations)
			.where(
				and(
					sql`${integrations.config}->>'recall_calendar_id' = ${calendarId}`,
					eq(integrations.status, 'active'),
				),
			)
			.limit(1)

		if (!integration) {
			logger.warn(`No integration found for recall calendar ${calendarId}`)
			return c.json({ ok: true, skipped: true })
		}

		const config = integration.config as IntegrationConfig
		const systemActorId = config?.system_actor_id
		if (!systemActorId) {
			return c.json({ ok: true, skipped: true })
		}

		// Load workspace notetaker settings
		const [ws] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, integration.workspaceId))
			.limit(1)

		const wsSettings = ws?.settings as Record<string, unknown> | undefined
		const notetakerSettings = wsSettings?.notetaker_settings as
			| { auto_join_mode?: string }
			| undefined
		const autoJoinMode = notetakerSettings?.auto_join_mode ?? 'all'

		if (autoJoinMode === 'manual') {
			// In manual mode, don't auto-schedule bots
			return c.json({ ok: true, mode: 'manual' })
		}

		// Fetch changed calendar events from Recall
		try {
			const calendarEvents = await listCalendarEvents(calendarId, lastUpdatedTs ?? undefined)

			for (const calEvent of calendarEvents) {
				// Skip events without video links
				if (!calEvent.meeting_url) continue

				// Apply auto_join_mode filter
				if (autoJoinMode === 'organized_by_me' && !calEvent.is_organizer) continue

				if (calEvent.is_deleted) {
					// Remove bot and mark meeting as deleted
					if (calEvent.bots.length > 0) {
						await deleteBotFromEvent(calEvent.id).catch((err) =>
							logger.error('Failed to delete bot from event', {
								eventId: calEvent.id,
								error: err instanceof Error ? err.message : String(err),
							}),
						)
					}
					// Mark existing meeting object as failed/cancelled
					await db
						.update(objects)
						.set({ status: 'failed', updatedAt: new Date() })
						.where(
							and(
								eq(objects.workspaceId, integration.workspaceId),
								eq(objects.type, 'meeting'),
								sql`${objects.metadata}->>'recall_event_id' = ${calEvent.id}`,
							),
						)
					continue
				}

				// Check if meeting object already exists for this calendar event
				const [existingMeeting] = await db
					.select({ id: objects.id, metadata: objects.metadata })
					.from(objects)
					.where(
						and(
							eq(objects.workspaceId, integration.workspaceId),
							eq(objects.type, 'meeting'),
							sql`${objects.metadata}->>'recall_event_id' = ${calEvent.id}`,
						),
					)
					.limit(1)

				if (existingMeeting) {
					// Already handled — skip
					continue
				}

				// Extract title from raw event data
				const raw = calEvent.raw ?? {}
				const title = (raw.summary as string) ?? (raw.subject as string) ?? '(No title)'

				// Create meeting object
				const [meetingObj] = await db
					.insert(objects)
					.values({
						workspaceId: integration.workspaceId,
						type: 'meeting',
						title,
						status: 'scheduled',
						metadata: {
							source: 'calendar',
							recall_event_id: calEvent.id,
							recall_calendar_id: calendarId,
							calendar_provider: integration.provider,
							meeting_url: calEvent.meeting_url,
							start: calEvent.start_time,
							end: calEvent.end_time,
							is_organizer: calEvent.is_organizer,
							bot_enabled: true,
						},
						createdBy: systemActorId,
					})
					.returning()

				if (!meetingObj) continue

				// Schedule bot via Recall Calendar V2 API
				const deduplicationKey = `${calEvent.start_time}-${calEvent.meeting_url}`
				try {
					const updatedEvent = await scheduleBotForEvent(
						calEvent.id,
						deduplicationKey,
						'Maskin Notetaker',
					)

					// Store bot_id from the scheduled bot
					const botId = updatedEvent.bots?.[0]?.id
					if (botId) {
						await db
							.update(objects)
							.set({
								metadata: {
									...(meetingObj.metadata as Record<string, unknown>),
									bot_id: botId,
								},
								updatedAt: new Date(),
							})
							.where(eq(objects.id, meetingObj.id))
					}
				} catch (botErr) {
					logger.error('Failed to schedule bot for calendar event', {
						eventId: calEvent.id,
						error: botErr instanceof Error ? botErr.message : String(botErr),
					})
					await db
						.update(objects)
						.set({
							status: 'failed',
							metadata: {
								...(meetingObj.metadata as Record<string, unknown>),
								error: botErr instanceof Error ? botErr.message : 'Bot scheduling failed',
							},
							updatedAt: new Date(),
						})
						.where(eq(objects.id, meetingObj.id))
				}

				// Log event
				await db.insert(events).values({
					workspaceId: integration.workspaceId,
					actorId: systemActorId,
					action: 'created',
					entityType: 'meeting',
					entityId: meetingObj.id,
					data: meetingObj,
				})
			}
		} catch (err) {
			logger.error('Failed to process calendar sync webhook', {
				calendarId,
				error: err instanceof Error ? err.message : String(err),
			})
		}

		return c.json({ ok: true })
	}

	// ── Bot status change: update meeting and trigger processing ──────────
	if (normalized.entityType === 'recall.bot') {
		const botId = normalized.data.bot_id as string

		const [meeting] = await db
			.select()
			.from(objects)
			.where(and(eq(objects.type, 'meeting'), sql`${objects.metadata}->>'bot_id' = ${botId}`))
			.limit(1)

		if (!meeting) {
			logger.warn(`No meeting found for recall bot ${botId}`)
			return c.json({ ok: true, skipped: true })
		}

		// Update meeting status based on bot action
		const statusMap: Record<string, string> = {
			recording: 'recording',
			fatal: 'failed',
		}
		const newStatus = statusMap[normalized.action]
		if (newStatus) {
			await db
				.update(objects)
				.set({ status: newStatus, updatedAt: new Date() })
				.where(eq(objects.id, meeting.id))
		}

		// Insert audit event
		await db.insert(events).values({
			workspaceId: meeting.workspaceId,
			actorId: meeting.createdBy,
			action: normalized.action,
			entityType: 'recall.bot',
			entityId: meeting.id,
			data: normalized.data,
		})

		// Auto-process when recording is done
		if (normalized.action === 'done') {
			const storageProvider = c.get('storageProvider') as StorageProvider
			const moduleEnv = { db, storageProvider } as ModuleEnv
			processRecording(meeting.id, botId, meeting.workspaceId, meeting.createdBy, moduleEnv).catch(
				(err) =>
					logger.error('Auto-process recording failed', {
						meetingId: meeting.id,
						botId,
						error: err instanceof Error ? err.message : String(err),
					}),
			)
		}

		logger.info(`Recall bot webhook: ${normalized.action} for meeting ${meeting.id}`)
		return c.json({ ok: true })
	}

	// Unknown recall event type
	return c.json({ ok: true, skipped: true })
}

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
