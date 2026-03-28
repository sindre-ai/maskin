import type { Database } from '@ai-native/db'
import { objects } from '@ai-native/db/schema'
import type { ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { processRecording } from '../services/pipeline.js'

type HonoEnv = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

/**
 * POST /api/m/notetaker/process
 *
 * Trigger transcription processing for a completed Recall.ai recording.
 * Called after a webhook event indicates the bot has finished recording.
 *
 * Body: { meetingId, botId }
 */
export function createProcessRoutes(env: ModuleEnv) {
	const app = new OpenAPIHono<HonoEnv>()

	app.post('/process', async (c) => {
		const actorId = c.get('actorId')
		const workspaceId = c.req.header('X-Workspace-Id')

		if (!workspaceId) {
			return c.json({ error: 'Missing X-Workspace-Id header' }, 400)
		}

		const body = await c.req.json<{ meetingId?: string; botId?: string }>()

		if (!body.meetingId || !body.botId) {
			return c.json({ error: 'Missing required fields: meetingId, botId' }, 400)
		}

		// Verify meeting exists and belongs to this workspace
		const [meeting] = await env.db
			.select()
			.from(objects)
			.where(and(eq(objects.id, body.meetingId), eq(objects.workspaceId, workspaceId)))
			.limit(1)

		if (!meeting) {
			return c.json({ error: 'Meeting not found' }, 404)
		}

		// Process asynchronously — respond immediately
		processRecording(body.meetingId, body.botId, workspaceId, actorId, env).catch((err) => {
			console.error('Recording processing failed', {
				meetingId: body.meetingId,
				botId: body.botId,
				error: err instanceof Error ? err.message : err,
			})
		})

		return c.json({ ok: true, meetingId: body.meetingId, status: 'processing' })
	})

	return app
}
