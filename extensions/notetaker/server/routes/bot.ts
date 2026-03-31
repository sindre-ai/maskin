import type { Database } from '@ai-native/db'
import { events, integrations, objects, workspaces } from '@ai-native/db/schema'
import type { ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono } from '@hono/zod-openapi'
import { and, eq, inArray } from 'drizzle-orm'
import { createBot } from '../services/recall.js'

type HonoEnv = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

interface IntegrationMeetingConfig {
	system_actor_id?: string
	recall_calendar_id?: string
	meeting_map?: Record<string, { recall_event_id?: string; bot_id?: string }>
	bot_map?: Record<string, string>
}

/**
 * POST /api/m/notetaker/bot
 *
 * Manually dispatch a Recall bot to a meeting URL.
 * Creates a meeting object and schedules a bot to join.
 * Stores bot_id in integration config bot_map (not object metadata).
 */
export function createBotRoutes(env: ModuleEnv) {
	const app = new OpenAPIHono<HonoEnv>()

	app.post('/bot', async (c) => {
		const actorId = c.get('actorId')
		const workspaceId = c.req.header('X-Workspace-Id')

		if (!workspaceId) {
			return c.json({ error: 'Missing X-Workspace-Id header' }, 400)
		}

		const body = await c.req.json<{ meeting_url?: string; title?: string }>()

		if (!body.meeting_url) {
			return c.json({ error: 'Missing required field: meeting_url' }, 400)
		}

		// Create meeting object with clean metadata
		const [meeting] = await env.db
			.insert(objects)
			.values({
				workspaceId,
				type: 'meeting',
				title: body.title || 'Manual meeting',
				status: 'scheduled',
				metadata: {
					meeting_url: body.meeting_url,
					send_meeting_bot: true,
				},
				createdBy: actorId,
			})
			.returning()

		if (!meeting) {
			return c.json({ error: 'Failed to create meeting' }, 500)
		}

		// Load workspace bot_config
		const [ws] = await env.db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1)
		const wsSettings = ws?.settings as Record<string, unknown> | undefined
		const notetakerSettings = wsSettings?.notetaker_settings as
			| { bot_config?: { bot_name?: string } }
			| undefined
		const botName = notetakerSettings?.bot_config?.bot_name || 'Sindre'

		// Find calendar integration to store bot_id in its config
		const [integration] = await env.db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					inArray(integrations.provider, ['google-calendar', 'outlook-calendar']),
					eq(integrations.status, 'active'),
				),
			)
			.limit(1)

		// Dispatch Recall bot
		try {
			const bot = await createBot(body.meeting_url, { botName })

			// Store bot_id in integration config bot_map
			if (integration) {
				const config = integration.config as IntegrationMeetingConfig
				const meetingMap = config.meeting_map ?? {}
				const botMap = config.bot_map ?? {}
				meetingMap[meeting.id] = { bot_id: bot.id }
				botMap[bot.id] = meeting.id
				await env.db
					.update(integrations)
					.set({
						config: { ...config, meeting_map: meetingMap, bot_map: botMap },
						updatedAt: new Date(),
					})
					.where(eq(integrations.id, integration.id))
			}

			// Log event
			await env.db.insert(events).values({
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'meeting',
				entityId: meeting.id,
				data: meeting,
			})

			return c.json({ ok: true, meetingId: meeting.id, botId: bot.id }, 201)
		} catch (err) {
			// Mark meeting as failed if bot dispatch fails
			await env.db
				.update(objects)
				.set({
					status: 'failed',
					metadata: {
						...(meeting.metadata as Record<string, unknown>),
						error: err instanceof Error ? err.message : 'Bot dispatch failed',
					},
					updatedAt: new Date(),
				})
				.where(eq(objects.id, meeting.id))

			return c.json(
				{
					error: 'Failed to dispatch bot',
					detail: err instanceof Error ? err.message : String(err),
					meetingId: meeting.id,
				},
				500,
			)
		}
	})

	return app
}
