import { events, integrations, objects } from '@ai-native/db/schema'
import type { ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { decrypt } from '../../../apps/dev/src/lib/crypto.js'
import type { CalendarProvider } from '../../../apps/dev/src/lib/integrations/calendar-types.js'
import { getProvider } from '../../../apps/dev/src/lib/integrations/registry.js'
import { getBotProvider } from './bot-providers/registry.js'

const workspaceIdHeader = z.object({
	'x-workspace-id': z.string().uuid(),
})

const idParamSchema = z.object({
	id: z.string().uuid(),
})

const providerParamSchema = z.object({
	provider: z.string(),
})

const errorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
	}),
})

export function meetingRoutes(env: ModuleEnv) {
	const app = new OpenAPIHono()

	// POST /sync — Force calendar sync for workspace
	const syncRoute = createRoute({
		method: 'post',
		path: '/sync',
		tags: ['Meetings'],
		summary: 'Sync calendar events',
		request: { headers: workspaceIdHeader },
		responses: {
			200: {
				content: { 'application/json': { schema: z.object({ synced: z.number() }) } },
				description: 'Calendar synced',
			},
		},
	})

	app.openapi(syncRoute, async (c) => {
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')
		const db = env.db

		// Find active calendar integration for this workspace
		const calendarProviders = ['google_calendar', 'outlook_calendar']
		const activeIntegrations = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.status, 'active')))
			.limit(10)

		const integration = activeIntegrations.find((r) => calendarProviders.includes(r.provider))

		if (!integration) {
			return c.json({ synced: 0 }, 200)
		}

		// Get the calendar provider
		let provider: CalendarProvider
		try {
			provider = getProvider(integration.provider) as CalendarProvider
		} catch {
			return c.json({ synced: 0 }, 200)
		}

		if (!('syncEvents' in provider)) {
			return c.json({ synced: 0 }, 200)
		}

		// Decrypt credentials and sync
		const credentials = JSON.parse(decrypt(integration.credentials))
		const config = (integration.config as Record<string, unknown>) ?? {}
		const syncToken = config.sync_token as string | undefined

		const result = await provider.syncEvents(credentials, { syncToken })

		const actorId = (config.system_actor_id as string) ?? 'system'
		let synced = 0

		// Create/update meeting objects from synced events
		for (const event of [...result.created, ...result.updated]) {
			const metadata = {
				calendar_event_id: event.externalId,
				calendar_provider: integration.provider,
				ical_uid: event.iCalUid,
				meeting_url: event.meetingUrl,
				meeting_platform: event.meetingPlatform,
				organizer_email: event.organizerEmail,
				start_time: event.startTime,
				end_time: event.endTime,
				timezone: event.timezone,
				attendees: event.attendees,
				is_recurring: event.isRecurring,
				recurrence_id: event.recurrenceId,
				integration_id: integration.id,
			}

			// Check if meeting already exists by calendar_event_id
			const existingMeetings = await db
				.select()
				.from(objects)
				.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'meeting')))

			const existing = existingMeetings.find((r) => {
				const m = r.metadata as Record<string, unknown> | null
				return (
					m?.calendar_event_id === event.externalId && m?.calendar_provider === integration.provider
				)
			})

			if (existing) {
				await db
					.update(objects)
					.set({ title: event.title, metadata, updatedAt: new Date() })
					.where(eq(objects.id, existing.id))

				await db.insert(events).values({
					workspaceId,
					actorId,
					action: 'updated',
					entityType: 'meeting',
					entityId: existing.id,
					data: { source: 'calendar_sync' },
				})
			} else {
				const [created] = await db
					.insert(objects)
					.values({
						workspaceId,
						type: 'meeting',
						title: event.title,
						status: 'scheduled',
						metadata,
						createdBy: actorId,
					})
					.returning()

				if (created) {
					await db.insert(events).values({
						workspaceId,
						actorId,
						action: 'created',
						entityType: 'meeting',
						entityId: created.id,
						data: { source: 'calendar_sync' },
					})
				}
			}
			synced++
		}

		// Save sync token for next incremental sync
		if (result.syncToken) {
			await db
				.update(integrations)
				.set({
					config: { ...config, sync_token: result.syncToken },
					updatedAt: new Date(),
				})
				.where(eq(integrations.id, integration.id))
		}

		return c.json({ synced }, 200)
	})

	// POST /:id/send-bot — Send recording bot to meeting
	const sendBotRoute = createRoute({
		method: 'post',
		path: '/{id}/send-bot',
		tags: ['Meetings'],
		summary: 'Send recording bot to meeting',
		request: { headers: workspaceIdHeader, params: idParamSchema },
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.object({ bot_id: z.string(), status: z.string() }),
					},
				},
				description: 'Bot scheduled',
			},
			404: {
				content: { 'application/json': { schema: errorSchema } },
				description: 'Meeting not found',
			},
		},
	})

	app.openapi(sendBotRoute, async (c) => {
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')
		const { id } = c.req.valid('param')
		const db = env.db

		// Find the meeting
		const [meeting] = await db
			.select()
			.from(objects)
			.where(
				and(eq(objects.id, id), eq(objects.workspaceId, workspaceId), eq(objects.type, 'meeting')),
			)
			.limit(1)

		if (!meeting) {
			return c.json({ error: { code: 'NOT_FOUND', message: 'Meeting not found' } }, 404)
		}

		const metadata = (meeting.metadata as Record<string, unknown>) ?? {}
		const meetingUrl = metadata.meeting_url as string
		if (!meetingUrl) {
			return c.json({ error: { code: 'BAD_REQUEST', message: 'Meeting has no join URL' } }, 404)
		}

		// Find active bot provider integration
		const botProviderNames = ['recall', 'fireflies', 'meetingbaas']
		const activeIntegrations = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.status, 'active')))
		const botIntegration = activeIntegrations.find((i) => botProviderNames.includes(i.provider))

		if (!botIntegration) {
			return c.json({ error: { code: 'NOT_FOUND', message: 'No bot provider connected' } }, 404)
		}

		// Get the bot provider
		const botProvider = getBotProvider(botIntegration.provider)
		if (!botProvider) {
			return c.json(
				{
					error: {
						code: 'NOT_FOUND',
						message: `Bot provider '${botIntegration.provider}' not available`,
					},
				},
				404,
			)
		}

		// Get API key from integration credentials
		const decryptedCreds = JSON.parse(decrypt(botIntegration.credentials))
		let apiKey: string
		try {
			const coreProvider = getProvider(botIntegration.provider)
			apiKey = await coreProvider.getAccessToken(decryptedCreds)
		} catch {
			apiKey = decryptedCreds.api_key
		}

		// Schedule the bot
		const result = await botProvider.scheduleBot(
			{
				meetingUrl,
				meetingTitle: meeting.title ?? undefined,
				startTime: metadata.start_time as string | undefined,
				deduplicationKey: `${metadata.start_time}-${meetingUrl}`,
			},
			{ apiKey },
		)

		// Update meeting metadata with bot info
		await db
			.update(objects)
			.set({
				metadata: {
					...metadata,
					bot_provider: botIntegration.provider,
					bot_id: result.botId,
					bot_status: result.status,
				},
				updatedAt: new Date(),
			})
			.where(eq(objects.id, id))

		// Log event
		const config = (botIntegration.config as Record<string, unknown>) ?? {}
		const actorId = (config.system_actor_id as string) ?? meeting.createdBy
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'bot_scheduled',
			entityType: 'meeting',
			entityId: id,
			data: { bot_id: result.botId, provider: botIntegration.provider },
		})

		return c.json({ bot_id: result.botId, status: result.status }, 200)
	})

	// DELETE /:id/remove-bot — Remove bot from meeting
	const removeBotRoute = createRoute({
		method: 'delete',
		path: '/{id}/remove-bot',
		tags: ['Meetings'],
		summary: 'Remove recording bot from meeting',
		request: { headers: workspaceIdHeader, params: idParamSchema },
		responses: {
			200: {
				content: { 'application/json': { schema: z.object({ removed: z.boolean() }) } },
				description: 'Bot removed',
			},
		},
	})

	app.openapi(removeBotRoute, async (c) => {
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')
		const { id } = c.req.valid('param')
		const db = env.db

		const [meeting] = await db
			.select()
			.from(objects)
			.where(
				and(eq(objects.id, id), eq(objects.workspaceId, workspaceId), eq(objects.type, 'meeting')),
			)
			.limit(1)

		if (!meeting) return c.json({ removed: false }, 200)

		const metadata = (meeting.metadata as Record<string, unknown>) ?? {}
		const botId = metadata.bot_id as string
		const botProviderName = metadata.bot_provider as string
		if (!botId || !botProviderName) return c.json({ removed: false }, 200)

		const botProvider = getBotProvider(botProviderName)
		if (!botProvider) return c.json({ removed: false }, 200)

		// Get API key from integration
		const [botIntegration] = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.provider, botProviderName),
					eq(integrations.status, 'active'),
				),
			)
			.limit(1)

		if (botIntegration) {
			const decryptedCreds = JSON.parse(decrypt(botIntegration.credentials))
			let apiKey: string
			try {
				const coreProvider = getProvider(botProviderName)
				apiKey = await coreProvider.getAccessToken(decryptedCreds)
			} catch {
				apiKey = decryptedCreds.api_key
			}
			await botProvider.cancelBot(botId, { apiKey })
		}

		// Clear bot info from metadata
		await db
			.update(objects)
			.set({
				metadata: { ...metadata, bot_id: null, bot_status: null, bot_provider: null },
				updatedAt: new Date(),
			})
			.where(eq(objects.id, id))

		return c.json({ removed: true }, 200)
	})

	// GET /:id/bot-status — Get bot status
	const botStatusRoute = createRoute({
		method: 'get',
		path: '/{id}/bot-status',
		tags: ['Meetings'],
		summary: 'Get recording bot status',
		request: { headers: workspaceIdHeader, params: idParamSchema },
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.object({
							bot_id: z.string().nullable(),
							status: z.string().nullable(),
						}),
					},
				},
				description: 'Bot status',
			},
		},
	})

	app.openapi(botStatusRoute, async (c) => {
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')
		const { id } = c.req.valid('param')
		const db = env.db

		const [meeting] = await db
			.select()
			.from(objects)
			.where(
				and(eq(objects.id, id), eq(objects.workspaceId, workspaceId), eq(objects.type, 'meeting')),
			)
			.limit(1)

		if (!meeting) return c.json({ bot_id: null, status: null }, 200)

		const metadata = (meeting.metadata as Record<string, unknown>) ?? {}
		return c.json(
			{
				bot_id: (metadata.bot_id as string) ?? null,
				status: (metadata.bot_status as string) ?? null,
			},
			200,
		)
	})

	// GET /:id/recording — Get recording storage key
	const recordingRoute = createRoute({
		method: 'get',
		path: '/{id}/recording',
		tags: ['Meetings'],
		summary: 'Get presigned recording URL',
		request: { headers: workspaceIdHeader, params: idParamSchema },
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.object({ url: z.string().nullable() }),
					},
				},
				description: 'Recording URL',
			},
		},
	})

	app.openapi(recordingRoute, async (c) => {
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')
		const { id } = c.req.valid('param')
		const db = env.db

		const [meeting] = await db
			.select()
			.from(objects)
			.where(
				and(eq(objects.id, id), eq(objects.workspaceId, workspaceId), eq(objects.type, 'meeting')),
			)
			.limit(1)

		if (!meeting) return c.json({ url: null }, 200)

		const metadata = (meeting.metadata as Record<string, unknown>) ?? {}
		const recording = metadata.recording as Record<string, unknown> | undefined
		return c.json({ url: (recording?.storage_key as string) ?? null }, 200)
	})

	// GET /:id/transcript — Get transcript storage key
	const transcriptRoute = createRoute({
		method: 'get',
		path: '/{id}/transcript',
		tags: ['Meetings'],
		summary: 'Get presigned transcript URL',
		request: { headers: workspaceIdHeader, params: idParamSchema },
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.object({ url: z.string().nullable() }),
					},
				},
				description: 'Transcript URL',
			},
		},
	})

	app.openapi(transcriptRoute, async (c) => {
		const { 'x-workspace-id': workspaceId } = c.req.valid('header')
		const { id } = c.req.valid('param')
		const db = env.db

		const [meeting] = await db
			.select()
			.from(objects)
			.where(
				and(eq(objects.id, id), eq(objects.workspaceId, workspaceId), eq(objects.type, 'meeting')),
			)
			.limit(1)

		if (!meeting) return c.json({ url: null }, 200)

		const metadata = (meeting.metadata as Record<string, unknown>) ?? {}
		const transcript = metadata.transcript as Record<string, unknown> | undefined
		return c.json({ url: (transcript?.storage_key as string) ?? null }, 200)
	})

	// POST /bot-webhook/:provider — Webhook from bot providers (no auth)
	const botWebhookRoute = createRoute({
		method: 'post',
		path: '/bot-webhook/{provider}',
		tags: ['Meetings'],
		summary: 'Bot provider webhook',
		request: { params: providerParamSchema },
		responses: {
			200: {
				content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
				description: 'Webhook processed',
			},
		},
	})

	app.openapi(botWebhookRoute, async (c) => {
		const { provider: providerName } = c.req.valid('param')
		const db = env.db

		const botProvider = getBotProvider(providerName)
		if (!botProvider) return c.json({ ok: false }, 200)

		const body = await c.req.text()
		const headers = Object.fromEntries(
			Object.entries(c.req.header()).map(([k, v]) => [k.toLowerCase(), v ?? '']),
		)

		// Normalize the webhook event
		const event = botProvider.normalizeWebhookEvent(JSON.parse(body), headers)
		if (!event) return c.json({ ok: true }, 200)

		// Find the meeting by bot_id across all workspaces
		// (webhooks don't include workspace context)
		const allMeetings = await db.select().from(objects).where(eq(objects.type, 'meeting'))

		const meeting = allMeetings.find((m) => {
			const meta = m.metadata as Record<string, unknown> | null
			return meta?.bot_id === event.botId
		})

		if (!meeting) return c.json({ ok: true }, 200)

		const metadata = (meeting.metadata as Record<string, unknown>) ?? {}

		// Update bot status
		if (event.eventType === 'status_change' && event.status) {
			await db
				.update(objects)
				.set({
					metadata: { ...metadata, bot_status: event.status },
					updatedAt: new Date(),
				})
				.where(eq(objects.id, meeting.id))

			await db.insert(events).values({
				workspaceId: meeting.workspaceId,
				actorId: meeting.createdBy,
				action: 'updated',
				entityType: 'meeting',
				entityId: meeting.id,
				data: { bot_status: event.status },
			})
		}

		// Handle recording ready — download and upload to S3
		if (event.eventType === 'recording_ready' && event.recordingUrl) {
			const [botIntegration] = await db
				.select()
				.from(integrations)
				.where(
					and(
						eq(integrations.workspaceId, meeting.workspaceId),
						eq(integrations.provider, providerName),
						eq(integrations.status, 'active'),
					),
				)
				.limit(1)

			if (botIntegration) {
				const decryptedCreds = JSON.parse(decrypt(botIntegration.credentials))
				let apiKey: string
				try {
					const coreProvider = getProvider(providerName)
					apiKey = await coreProvider.getAccessToken(decryptedCreds)
				} catch {
					apiKey = decryptedCreds.api_key
				}

				try {
					const recording = await botProvider.getRecording(event.botId, { apiKey })

					// Download the recording file
					const response = await fetch(recording.downloadUrl)
					const buffer = Buffer.from(await response.arrayBuffer())

					// Upload to S3
					const storageKey = `meetings/${meeting.workspaceId}/${meeting.id}/recording.${recording.format}`
					await env.storageProvider.put(storageKey, buffer)

					// Update meeting metadata
					await db
						.update(objects)
						.set({
							metadata: {
								...metadata,
								bot_status: 'done',
								recording: {
									storage_key: storageKey,
									format: recording.format,
									duration_seconds: recording.durationSeconds,
									size_bytes: buffer.length,
								},
							},
							status: 'processing',
							updatedAt: new Date(),
						})
						.where(eq(objects.id, meeting.id))

					await db.insert(events).values({
						workspaceId: meeting.workspaceId,
						actorId: meeting.createdBy,
						action: 'recording_ready',
						entityType: 'meeting',
						entityId: meeting.id,
						data: { storage_key: storageKey },
					})
				} catch (err) {
					console.error('Failed to download recording:', err)
				}
			}
		}

		// Handle errors
		if (event.eventType === 'error') {
			await db
				.update(objects)
				.set({
					metadata: { ...metadata, bot_status: 'failed' },
					status: 'cancelled',
					updatedAt: new Date(),
				})
				.where(eq(objects.id, meeting.id))
		}

		return c.json({ ok: true }, 200)
	})

	return app
}
