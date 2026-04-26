import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { headlineResponseSchema } from '@maskin/shared'
import { createApiError } from '../lib/errors'
import { errorSchema } from '../lib/openapi-schemas'
import { isWorkspaceMember } from '../lib/workspace-auth'
import { buildHeadline } from '../services/dashboard-headline'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

const headlineParamsSchema = z.object({
	id: z.string().uuid(),
})

// GET /api/workspaces/:id/headline
const headlineRoute = createRoute({
	method: 'get',
	path: '/{id}/headline',
	tags: ['workspaces'],
	summary: 'Get the workspace dashboard headline (LLM with rule-based fallback)',
	request: {
		params: headlineParamsSchema,
	},
	responses: {
		200: {
			description: 'One-sentence narrative summary of the workspace state',
			content: { 'application/json': { schema: headlineResponseSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(headlineRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	// Auth middleware only enforces workspace membership when X-Workspace-Id is
	// present in the header; this route uses the path param, so check explicitly
	// (same pattern as objects/triggers/notifications by-id routes). Without
	// this, any authenticated caller could read another workspace's headline
	// AND drain its configured LLM credits by hitting unique 5-min cache buckets.
	if (!(await isWorkspaceMember(db, actorId, id))) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const headline = await buildHeadline(db, id)
	if (!headline) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	return c.json(headline)
}) as RouteHandler<typeof headlineRoute, Env>)

export default app
