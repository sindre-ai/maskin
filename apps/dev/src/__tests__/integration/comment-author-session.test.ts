import { OpenAPIHono } from '@hono/zod-openapi'
import { events } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// POST /api/events records which session the author was running, taken from the
// X-Maskin-Session-Id header only, so CommentDispatcher can link a session started
// by an @mention. A request body must not be able to write it.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { default: eventsRoutes } = await import('../../routes/events')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function buildApp() {
	const outer = new OpenAPIHono<{ Variables: { maskinSessionId?: string } }>()
	// Same shape check app-factory.ts applies to the header.
	outer.use('*', async (c, next) => {
		const raw = c.req.header('X-Maskin-Session-Id')?.trim()
		if (raw && UUID_RE.test(raw)) c.set('maskinSessionId', raw)
		await next()
	})
	outer.route('/', createIntegrationApp({ path: '/api/events', module: eventsRoutes as never }))
	return outer
}

describe('POST /api/events author session (integration)', () => {
	async function post(headers: Record<string, string>, extra?: Record<string, unknown>) {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const object = await insertObject(db, ws.id, human, { type: 'task', title: 'author session' })
		const res = await buildApp().request(
			jsonRequest(
				'POST',
				'/api/events',
				{ entity_id: object.id, content: 'a comment', ...extra },
				{ 'X-Workspace-Id': ws.id, ...headers },
			),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { id: number }
		const [row] = await db.select().from(events).where(eq(events.id, body.id))
		return (row.data ?? {}) as { authorSessionId?: string; metadata?: Record<string, unknown> }
	}

	it('stores the header’s session id on the comment event', async () => {
		const sessionId = '2297f7f3-dd73-43cf-afbe-3aabd0711265'
		const data = await post({ 'X-Maskin-Session-Id': sessionId })
		expect(data.authorSessionId).toBe(sessionId)
	})

	it('stores nothing when the header is missing or not a uuid', async () => {
		expect((await post({})).authorSessionId).toBeUndefined()
		expect((await post({ 'X-Maskin-Session-Id': 'nope' })).authorSessionId).toBeUndefined()
	})

	it('a session id in the request body or its metadata is not stored as the author session', async () => {
		const planted = '11111111-2222-4333-8444-555555555555'
		const data = await post(
			{},
			{ metadata: { authorSessionId: planted }, authorSessionId: planted },
		)
		expect(data.authorSessionId).toBeUndefined()
	})
})
