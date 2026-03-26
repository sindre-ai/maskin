import type { ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

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

export function meetingRoutes(_env: ModuleEnv) {
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
		// TODO: Implement calendar sync
		return c.json({ synced: 0 }, 200)
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
		// TODO: Look up meeting, find workspace bot provider integration, call botProvider.scheduleBot()
		return c.json({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented yet' } }, 404)
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
		// TODO: Implement
		return c.json({ removed: false }, 200)
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
		// TODO: Implement
		return c.json({ bot_id: null, status: null }, 200)
	})

	// GET /:id/recording — Get presigned recording URL
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
		// TODO: Look up meeting, get recording storage_key, generate presigned S3 URL
		return c.json({ url: null }, 200)
	})

	// GET /:id/transcript — Get presigned transcript URL
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
		// TODO: Look up meeting, get transcript storage_key, generate presigned S3 URL
		return c.json({ url: null }, 200)
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
		// TODO: Verify webhook, normalize event, find meeting by bot_id, update metadata
		return c.json({ ok: true }, 200)
	})

	return app
}
