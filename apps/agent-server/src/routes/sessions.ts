import type { Database } from '@maskin/db'
import { sessionLogs, sessions } from '@maskin/db/schema'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, asc, eq, gt } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { SessionLogEvent, SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		sessionManager: SessionManager
	}
}

const app = new Hono<Env>()

// POST / — create & start session
app.post('/', async (c) => {
	const sessionManager = c.get('sessionManager')
	const body = await c.req.json<{
		workspace_id: string
		actor_id: string
		action_prompt: string
		config?: Record<string, unknown>
		trigger_id?: string
		created_by: string
		auto_start?: boolean
	}>()

	if (!body.workspace_id || !body.actor_id || !body.action_prompt || !body.created_by) {
		return c.json({ error: 'Missing required fields: workspace_id, actor_id, action_prompt, created_by' }, 400)
	}

	try {
		const session = await sessionManager.createSession(body.workspace_id, {
			actorId: body.actor_id,
			actionPrompt: body.action_prompt,
			config: body.config,
			triggerId: body.trigger_id,
			createdBy: body.created_by,
			autoStart: body.auto_start,
		})
		return c.json(session, 201)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		logger.error('Failed to create session', { error: message })
		return c.json({ error: message }, 500)
	}
})

// POST /:id/stop — stop session
app.post('/:id/stop', async (c) => {
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.param()

	try {
		await sessionManager.stopSession(id)
		const db = c.get('db')
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
		if (!updated) return c.json({ error: 'Session not found' }, 404)
		return c.json(updated)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json({ error: message }, 400)
	}
})

// POST /:id/pause — pause & snapshot
app.post('/:id/pause', async (c) => {
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.param()

	try {
		await sessionManager.pauseSession(id)
		const db = c.get('db')
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
		if (!updated) return c.json({ error: 'Session not found' }, 404)
		return c.json(updated)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json({ error: message }, 400)
	}
})

// POST /:id/resume — resume from snapshot
app.post('/:id/resume', async (c) => {
	const sessionManager = c.get('sessionManager')
	const { id } = c.req.param()

	try {
		await sessionManager.resumeSession(id)
		const db = c.get('db')
		const [updated] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
		if (!updated) return c.json({ error: 'Session not found' }, 404)
		return c.json(updated)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json({ error: message }, 400)
	}
})

// GET /:id/status — get session status
app.get('/:id/status', async (c) => {
	const db = c.get('db')
	const { id } = c.req.param()

	const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	if (!session) return c.json({ error: 'Session not found' }, 404)

	return c.json({
		id: session.id,
		status: session.status,
		started_at: session.startedAt,
		completed_at: session.completedAt,
		result: session.result,
	})
})

// GET /:id/logs/stream — SSE log stream
app.get('/:id/logs/stream', async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const { id: sessionId } = c.req.param()
	const lastLogId = c.req.header('Last-Event-ID')

	const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
	if (!session) return c.json({ error: 'Session not found' }, 404)

	const terminalStatuses = ['completed', 'failed', 'timeout']

	return streamSSE(c, async (stream) => {
		if (terminalStatuses.includes(session.status)) {
			const allLogs = await db
				.select()
				.from(sessionLogs)
				.where(eq(sessionLogs.sessionId, sessionId))
				.orderBy(asc(sessionLogs.id))

			for (const log of allLogs) {
				await stream.writeSSE({
					id: String(log.id),
					event: log.stream,
					data: log.content,
				})
			}
			await stream.writeSSE({ event: 'done', data: session.status })
			return
		}

		const parsedLogId = Number(lastLogId)
		if (lastLogId && !Number.isNaN(parsedLogId)) {
			const missed = await db
				.select()
				.from(sessionLogs)
				.where(and(eq(sessionLogs.sessionId, sessionId), gt(sessionLogs.id, parsedLogId)))
				.orderBy(asc(sessionLogs.id))
				.limit(500)

			for (const log of missed) {
				await stream.writeSSE({
					id: String(log.id),
					event: log.stream,
					data: log.content,
				})
			}
		}

		let closed = false
		const handler = (event: SessionLogEvent) => {
			if (event.sessionId !== sessionId) return
			stream.writeSSE({
				id: String(event.logId),
				event: event.stream,
				data: event.data,
			})

			if (event.stream === 'system' && event.data.startsWith('Session completed')) {
				closed = true
				stream.writeSSE({ event: 'done', data: 'completed' })
			}
			if (event.stream === 'system' && event.data.startsWith('Session failed')) {
				closed = true
				stream.writeSSE({ event: 'done', data: 'failed' })
			}
		}

		sessionManager.on('log', handler)
		stream.onAbort(() => {
			sessionManager.off('log', handler)
		})

		while (!closed) {
			await stream.sleep(30000)
		}
	})
})

export default app
