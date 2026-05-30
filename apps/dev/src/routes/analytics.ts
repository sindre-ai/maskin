import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { analyticsEvents } from '@maskin/db/schema'
import { recordAnalyticsEventSchema } from '@maskin/shared'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// POST /api/analytics — record a single product analytics event.
//
// Frontend `trackEvent` (apps/web/src/lib/analytics.ts) calls this once per
// event. Workspace membership is enforced explicitly because authMiddleware
// only checks membership for list-style routes; we accept events scoped to
// the X-Workspace-Id header.
const recordRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Analytics'],
	summary: 'Record a single product analytics event.',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: recordAnalyticsEventSchema } } },
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
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(recordRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a workspace member'), 403)
	}

	await db.insert(analyticsEvents).values({
		workspaceId,
		actorId,
		name: body.name,
		props: body.props ?? {},
	})

	logger.info('analytics event recorded', {
		workspaceId,
		actorId,
		name: body.name,
	})

	return c.json({ recorded: true as const }, 202)
}) as RouteHandler<typeof recordRoute, Env>)

export default app
