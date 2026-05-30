import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { analyticsEvents } from '@maskin/db/schema'
import { trackEventSchema } from '@maskin/shared'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// POST /api/analytics — record a single first-party UI analytics event.
// Workspace membership is enforced by authMiddleware via X-Workspace-Id.
const recordRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Analytics'],
	summary: 'Record a first-party UI analytics event.',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: trackEventSchema } } },
	},
	responses: {
		202: {
			description: 'Event accepted',
			content: { 'application/json': { schema: z.object({ recorded: z.literal(true) }) } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(recordRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	await db.insert(analyticsEvents).values({
		workspaceId,
		actorId,
		name: body.name,
		props: body.props ?? {},
	})

	logger.info('analytics_event recorded', {
		workspaceId,
		actorId,
		name: body.name,
	})

	return c.json({ recorded: true as const }, 202)
}) as RouteHandler<typeof recordRoute, Env>)

export default app
